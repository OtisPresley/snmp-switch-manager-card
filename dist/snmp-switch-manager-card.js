// Internal: normalize config without changing behavior.
// This provides a single canonical place to evolve config handling over time.

// Internal: natural-ish compare for interface names like Gi1/0/2 vs Gi1/0/10.
// Splits into alpha and numeric tokens and compares token-by-token.
function _ssmNaturalPortCompare(a, b) {
  const sa = String(a ?? "");
  const sb = String(b ?? "");
  if (sa === sb) return 0;

  const ta = sa.match(/(\d+|[^\d]+)/g) || [sa];
  const tb = sb.match(/(\d+|[^\d]+)/g) || [sb];
  const n = Math.max(ta.length, tb.length);

  for (let i = 0; i < n; i++) {
    const xa = ta[i];
    const xb = tb[i];
    if (xa == null) return -1;
    if (xb == null) return 1;

    const na = /^\d+$/.test(xa);
    const nb = /^\d+$/.test(xb);

    if (na && nb) {
      const ia = parseInt(xa, 10);
      const ib = parseInt(xb, 10);
      if (ia !== ib) return ia - ib;
      // same numeric value but different width (e.g., 01 vs 1)
      if (xa.length !== xb.length) return xa.length - xb.length;
    } else if (!na && !nb) {
      const ca = xa.localeCompare(xb, undefined, { sensitivity: "base" });
      if (ca !== 0) return ca;
    } else {
      // put alpha tokens before numeric tokens for stability
      return na ? 1 : -1;
    }
  }

  return sa.localeCompare(sb, undefined, { sensitivity: "base" });
}

function _ssmNormalizeConfig(config) {
  // IMPORTANT: do not introduce new defaults here unless they already exist implicitly
  // in the card/editor behavior. Keep this behavior-preserving.
  if (!config || typeof config !== "object") return {};
  // Shallow clone to avoid accidental external mutation.
  const out = { ...config };

// Port gap: canonical keys (preferred). Older keys are mapped once for backward compatibility.
// Official keys: horizontal_port_gap, vertical_port_gap
const hasH = out.horizontal_port_gap != null && out.horizontal_port_gap !== "";
const hasV = out.vertical_port_gap != null && out.vertical_port_gap !== "";
if (!hasH || !hasV) {
  // Backward compat sources (deprecated): port_gap_x/y, gap_x/y, gap
  const legacyH = (out.port_gap_x ?? out.gap_x ?? out.gap);
  const legacyV = (out.port_gap_y ?? out.gap_y ?? out.gap);
  if (!hasH && legacyH != null && legacyH !== "") out.horizontal_port_gap = legacyH;
  if (!hasV && legacyV != null && legacyV !== "") out.vertical_port_gap = legacyV;
}

  // Drop deprecated / renamed keys to keep saved YAML clean.
  // Keep this list explicit (do not strip unknown future keys).
  const deprecatedKeys = [
    "port_gap_y",
    "port_gap_x",
    "gap_y",
    "gap_x",
    "gap",
    "show_uplinks_separately_in_layout", // old/typo key
  ];
  for (const k of deprecatedKeys) {
    if (k in out) delete out[k];
  }

  return out;
}



function _ssmNormListToSet(v) {
  // Accept array of strings, comma-separated string, or null/undefined.
  const out = new Set();
  if (Array.isArray(v)) {
    for (const it of v) {
      const k = String(it ?? "").trim().toLowerCase();
      if (k) out.add(k);
    }
    return out;
  }
  if (typeof v === "string") {
    for (const part of v.split(",")) {
      const k = String(part ?? "").trim().toLowerCase();
      if (k) out.add(k);
    }
  }
  return out;
}


function _ssmIsHiddenPort(config, portName, entityId) {
  try {
    const set = _ssmNormListToSet(config?.hide_ports);
    if (!set || set.size === 0) return false;
    const n = String(portName ?? "").trim().toLowerCase();
    const e = String(entityId ?? "").trim().toLowerCase();
    return (n && set.has(n)) || (e && set.has(e));
  } catch (e) {
    return false;
  }
}


class SnmpSwitchManagerCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;

        // SNMP Switch Manager devices (device registry)
        this._snmpDevices = null; // [{id,name,prefix}]
        this._loadingDevices = false;
    this._config = null;
    this._hasHass = false;
    this._hasConfig = false;
    this._rendered = false;

    // Registries / scoping
    this._entityReg = null;
    this._deviceReg = null;
    this._anchorDeviceId = null;

    // Persist modal AND its stylesheet across renders
    this._modalEl = null;
    this._modalStyle = null;
  
    // Bandwidth graph modal state (kept outside normal render cycle to avoid chart redraw/jitter)
    this._graphModalEl = null;
    this._bandwidthGraphModalRoot = null;
    this._bandwidthGraphModalStyle = null;
    this._graphCardEl = null;
    this._freezeRenderWhileGraphOpen = false;
    this._freezeRenderWhileDragging = false;

    // Calibration persistence (localStorage)
    this._calibPersistT = null;


    // Editor draft values to prevent re-render from clobbering input while typing
    this._draftValues = {};
    this._editingFields = new Set();
    // Background image aspect cache (for Panel width = 0 autosizing without stretching)
    this._bgAspectByUrl = new Map();   // url -> aspect (w/h)
    this._bgAspectLoading = new Set(); // urls in flight
}


  connectedCallback() {
    // Lazily probe background image aspect ratio in the browser.
    try { this._maybeLoadBgAspect(); } catch (e) {}
  }

  _maybeLoadBgAspect() {
    const url = String(this._config?.background_image || "").trim();
    if (!url) return;
    if (this._bgAspectByUrl.has(url)) return;
    if (this._bgAspectLoading.has(url)) return;
    if (typeof Image === "undefined") return;

    this._bgAspectLoading.add(url);
    const img = new Image();
    img.onload = () => {
      try {
        const w = Number(img.naturalWidth || img.width);
        const h = Number(img.naturalHeight || img.height);
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
          this._bgAspectByUrl.set(url, w / h);
          // Re-render now that we know the aspect.
          this.requestUpdate?.();
          this._render?.();
        }
      } finally {
        this._bgAspectLoading.delete(url);
      }
    };
    img.onerror = () => { this._bgAspectLoading.delete(url); };
    // Use absolute URL resolution to match what the browser will load in CSS.
    try { img.src = new URL(url, window.location.href).toString(); }
    catch (e) { img.src = url; }
  }



_layoutEditorSessionKey() {
  const dev = String(this._config?.device || "all");
  const title = String(this._config?.title || "");
  return `ssm_layout_editor_closed:${dev}:${title}`;
}

_isLayoutEditorClosedBySession() {
  try { return sessionStorage.getItem(this._layoutEditorSessionKey()) === "1"; }
  catch (e) { return false; }
}

_clearLayoutEditorSessionClosed() {
  try { sessionStorage.removeItem(this._layoutEditorSessionKey()); } catch (e) {}
}

_setLayoutEditorSessionClosed() {
  try { sessionStorage.setItem(this._layoutEditorSessionKey(), "1"); } catch (e) {}
}

  setConfig(config) {
    config = _ssmNormalizeConfig(config);

    const prevCalib = this._isCalibrationEnabled();

    this._config = {
      title: config.title ?? "",
      view: (config.view === "panel" ? "panel" : "list"),

      // Port color representation: "state" (default) or "speed"
      color_mode: (config.color_mode === "speed") ? "speed" : "state",
      // Optional per-speed color overrides (keyed by normalized speed labels like "1 Gbps")
      show_all_speeds: config.show_all_speeds === true,
      speed_colors: (config.speed_colors && typeof config.speed_colors === "object" && !Array.isArray(config.speed_colors))
        ? { ...config.speed_colors }
        : null,
      // Optional per-state color overrides (Admin/Oper status)
      state_colors: (config.state_colors && typeof config.state_colors === "object" && !Array.isArray(config.state_colors))
        ? { ...config.state_colors }
        : null,



      ports_per_row: Number.isFinite(config.ports_per_row) ? Number(config.ports_per_row) : 24,
      panel_width: Number.isFinite(config.panel_width) ? Number(config.panel_width) : 740,
      // Port size is now controlled via Port scale + Layout Editor; keep internal base size.
      port_size: 18,
      horizontal_port_gap: Number.isFinite(Number(config.horizontal_port_gap)) ? Number(config.horizontal_port_gap) : 10,
      vertical_port_gap: Number.isFinite(Number(config.vertical_port_gap)) ? Number(config.vertical_port_gap) : 10,
      show_labels: config.show_labels !== false,
      label_numbers_only: config.label_numbers_only === true,
      label_numbers_from: (config.label_numbers_from === "port_name" || config.label_numbers_from === "index") ? config.label_numbers_from : "index",
      label_outline: config.label_outline === true,
      label_size: Number.isFinite(config.label_size) ? Number(config.label_size) : 8,
      label_position: (config.label_position === "above" || config.label_position === "inside" || config.label_position === "below" || config.label_position === "split")
        ? config.label_position
        : "below",

      // If true, hide all in-card Turn on/Turn off buttons (virtual interfaces + port popup)
      // for users who want a "view-only" card.
      hide_control_buttons: config.hide_control_buttons === true,

      // choose where Diagnostics/Virtual block appears
      info_position: (config.info_position === "below") ? "below" : "above",

      // Scoping
      anchor_entity: config.anchor_entity ?? null,
      device_name: config.device_name ?? null,
      device: config.device ?? null,
      unit: Number.isFinite(config.unit) ? Number(config.unit) : null,
      slot: Number.isFinite(config.slot) ? Number(config.slot) : null,
      ports: Array.isArray(config.ports) ? config.ports : null,

      // Diagnostics are auto-discovered (Hostname/Manufacturer/Model/Firmware/Uptime)
// Users can optionally reorder via diagnostics_order.
      diagnostics_order: (Array.isArray(config.diagnostics_order) && config.diagnostics_order.length)
        ? config.diagnostics_order
        : (Array.isArray(config.diagnostics) && config.diagnostics.length)
          ? (() => {
              const known = ["hostname","manufacturer","model","firmware_revision","uptime"];
              const out = [];
              for (const id of config.diagnostics) {
                const m = String(id).match(/_(hostname|manufacturer|model|firmware_revision|uptime)$/);
                if (m && !out.includes(m[1])) out.push(m[1]);
              }
              for (const k of known) if (!out.includes(k)) out.push(k);
              return out;
            })()
          : ["hostname","manufacturer","model","firmware_revision","uptime"],

      // Optional per-diagnostic enable/disable map.
      // Keys can be built-in diagnostic keys (hostname/model/...) or custom entity_ids.
      diagnostics_enabled: (config.diagnostics_enabled && typeof config.diagnostics_enabled === "object" && !Array.isArray(config.diagnostics_enabled))
        ? { ...config.diagnostics_enabled }
        : {},

      // Optional custom background image + port positioning (panel view only)
      background_image: (typeof config.background_image === "string" && config.background_image.trim()) ? config.background_image.trim() : null,
      // Ports offset is deprecated (Layout Editor replaces it).
      ports_offset_x: 0,
      ports_offset_y: 0,
      // Accept both legacy key (ports_scale) and the editor key (port_scale)
      ports_scale: Number.isFinite(config.port_scale)
        ? Number(config.port_scale)
        : (Number.isFinite(config.ports_scale) ? Number(config.ports_scale) : 1),
      port_positions: (config.port_positions && typeof config.port_positions === "object") ? config.port_positions : null,
      virtual_overrides: Array.isArray(config.virtual_overrides) ? config.virtual_overrides : ((typeof config.virtual_overrides === "string") ? config.virtual_overrides.split(",").map(s=>s.trim()).filter(Boolean) : null),
      physical_prefixes: (typeof config.physical_prefixes === "string") ? config.physical_prefixes : null,
      physical_regex: (typeof config.physical_regex === "string") ? config.physical_regex : null,

      calibration_mode: config.calibration_mode === true,

// Optional panel visibility
      hide_diagnostics: config.hide_diagnostics === true,
      hide_virtual_interfaces: config.hide_virtual_interfaces === true,
      // Port visibility
      hide_ports: Array.isArray(config.hide_ports) ? config.hide_ports : (typeof config.hide_ports === "string" ? config.hide_ports.split(",").map(s=>s.trim()).filter(Boolean) : []),

      // Label styling
      label_color: config.label_color ?? config.label_font_color ?? "",
      label_bg_color: config.label_bg_color ?? config.label_background_color ?? "",

      // Label options
      label_numbers_only: config.label_numbers_only === true,
      label_outline: config.label_outline === true,

      // Uplinks
      show_uplinks_separately: config.show_uplinks_separately === true,
      uplink_ports: Array.isArray(config.uplink_ports) ? config.uplink_ports : (typeof config.uplink_ports === "string" ? config.uplink_ports.split(",").map(s=>s.trim()).filter(Boolean) : []),
      // When Port colors = Speed: clicking a port can open the traffic graph instead of the port info modal
      speed_click_opens_graph: config.speed_click_opens_graph === true,

    };

    // If the user closed the Layout Editor overlay, keep it hidden until they toggle Layout Editor off/on.
    if (!this._config.calibration_mode) this._calibUiClosed = false;
    else if (!prevCalib && this._config.calibration_mode) this._calibUiClosed = false;

    this._safeRender();
}

  set hass(hass) {
    this._hass = hass;

    // If a port dialog is open, keep its toggle label in sync with live state
    if (this._modalEl && this._modalEntityId) {
      const st = hass?.states?.[this._modalEntityId];
      const btn = this._modalEl.querySelector('.ssm-modal-actions .btn.wide');
      if (btn && st) btn.textContent = this._buttonLabel(st);
    }

    // When the bandwidth graph is open, avoid wiping/rebuilding the DOM on every hass update.
    // That re-parenting causes the statistics-graph to constantly redraw.
    if (this._graphModalEl && this._freezeRenderWhileGraphOpen) {
      return;
    }

    // While in Layout Editor, Lovelace frequently triggers hass updates which cause the card
    // to rebuild its entire DOM. That rebuild cancels pointer capture (drag 'drops') and resets
    // the calibration JSON textarea scroll. Mirror the existing graph/modal strategy: freeze
    // renders during calibration and let the user finish positioning first.
    if (this._isCalibrationEnabled() && this._freezeRenderWhileCalibrationActive) {
      return;
    }

    // While drag-calibrating, don't re-render on hass churn (it cancels pointer capture and 'drops' the drag)
    if (this._freezeRenderWhileDragging) {
      return;
    }

    this._safeRender();
}

  getCardSize() { return 5; }


  _safeRender() {
    try {
      this._render();
    } catch (err) {
      // Never let a render exception blank the whole card; show a visible error.
      // eslint-disable-next-line no-console
      console.error("SNMP Switch Manager Card render error:", err);
      const msg = (err && (err.stack || err.message)) ? String(err.stack || err.message) : String(err);
      this.shadowRoot.innerHTML = `
        <ha-card style="padding:12px;">
          <div style="font-weight:600; margin-bottom:8px;">SNMP Switch Manager Card error</div>
          <pre style="white-space:pre-wrap; font-size:12px; opacity:0.85;">${msg.replace(/</g,"&lt;")}</pre>
        </ha-card>`;
            }
  }


  // ---------- registries ----------
  async _ensureRegistries() {
    if (!this._hass) return;
    const tasks = [];
    if (!this._entityReg)
      tasks.push(this._hass.callWS({ type: "config/entity_registry/list" }).then(r => this._entityReg = r));
    if (!this._deviceReg)
      tasks.push(this._hass.callWS({ type: "config/device_registry/list" }).then(r => this._deviceReg = r));
    if (tasks.length) await Promise.all(tasks).catch(()=>{});
  }

  _deviceIdForEntity(entity_id) {
    const row = this._entityReg?.find(e => e.entity_id === entity_id);
    return row?.device_id ?? null;
  }

  async _resolveAnchorDeviceId() {
    if (!this._config.anchor_entity) return null;
    await this._ensureRegistries();
    this._anchorDeviceId = this._deviceIdForEntity(this._config.anchor_entity);
    return this._anchorDeviceId;
  }

  // ---------- helpers ----------
  _parseTriple(name) {
    const m = String(name).toUpperCase().match(/^([A-Z]{2})(\d+)\/(\d+)\/(\d+)$/);
    if (!m) return null;
    return { kind: m[1], unit: +m[2], slot: +m[3], port: +m[4] };
  }

  _kindPriority(k) {
    k = String(k || "").toUpperCase();
    return k === "GI" ? 0 : k === "TE" ? 1 : k === "TW" ? 2 : 3;
  }


  _inferDevicePrefix() {
    const cfg = this._config || {};
    if (cfg.device) return String(cfg.device);
    const ae = cfg.anchor_entity ? String(cfg.anchor_entity) : "";
    const ent = ae.includes(".") ? ae.split(".")[1] : "";
    // Try to infer prefix from common port naming patterns: <prefix>_<kind><...>
    const m = ent.match(/^(.+?)_(gi|fa|ge|te|tw|xe|et|eth|po|vlan|slot)\d/i);
    if (m) return m[1];
    // Fallback: first token before first underscore
    return ent ? ent.split("_")[0] : "";
  }

  _getDiagnosticsEntityIds() {
    const H = this._hass?.states || {};
    const prefix = this._inferDevicePrefix();
    if (!prefix) return [];

    // Built-in diagnostic keys mapped to entity suffixes
    const builtin = ["hostname", "manufacturer", "model", "firmware_revision", "uptime"];
    const aliasToBuiltin = {
      firmware: "firmware_revision",
      firmware_revision: "firmware_revision",
    };

    const rawOrder = (Array.isArray(this._config?.diagnostics_order) && this._config.diagnostics_order.length)
      ? this._config.diagnostics_order
      : builtin;

    const enabledMap = (this._config?.diagnostics_enabled && typeof this._config.diagnostics_enabled === "object")
      ? this._config.diagnostics_enabled
      : {};

    // Inject Environment/PoE defaults when the underlying data exists.
    const order = this._injectAutoDiagDefaults(rawOrder, enabledMap);

    const out = [];
    for (const raw of order) {
      const key = String(raw || "").trim();
      if (!key) continue;

      // Skip disabled
      if (enabledMap[key] === false) continue;

      // Attribute-backed diagnostic: "sensor.x#Attribute Name"
      if (key.includes("#") && key.includes(".")) {
        const [eid, attr] = key.split("#");
        const st = H[eid];
        const v = st?.attributes?.[attr];
        if (st && v != null) out.push(key);
        continue;
      }

      // Custom entity_id (e.g. sensor.some_sensor)
      if (key.includes(".")) {
        if (H[key]) out.push(key);
        continue;
      }


      // Built-in key (with aliases)
      const mapped = aliasToBuiltin[key] || key;
      if (!builtin.includes(mapped)) continue;

      const eid = `sensor.${prefix}_${mapped}`;
      if (enabledMap[mapped] === false) continue; // support disabling via mapped key too
      if (H[eid]) out.push(eid);
    }
    return out;
  }

  _stripDiagPrefix(name) {
    if (typeof name !== "string") return name;
    const prefix = this._inferDevicePrefix();
    if (!prefix) return name;
    const cand = prefix.replace(/_/g, "-").toUpperCase();
    const re = new RegExp("^" + cand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s+", "i");
    return name.replace(re, "");
  }


  _autoDefaultDiagKeys(prefix, H) {
    // Return a list of *resolved* diagnostic keys (entity_id or "entity_id#Attribute Name")
    // in the desired order, but only when the underlying data exists.
    const out = [];

    const envAgg = `sensor.${prefix}_environment`;
    const poeAgg = `sensor.${prefix}_power_over_ethernet`;

    // Environment: System Temperature (°C)
    const envTemp = `sensor.${prefix}_system_temperature`;
    if (H[envTemp]) out.push(envTemp);
    else {
      const st = H[envAgg];
      const v = st?.attributes?.["System Temperature (°C)"];
      if (v != null) out.push(`${envAgg}#System Temperature (°C)`);
    }

    // Environment: System Temperature Status
    const envStatus = `sensor.${prefix}_system_temperature_status`;
    if (H[envStatus]) out.push(envStatus);
    else {
      const st = H[envAgg];
      const v = st?.attributes?.["System Temperature Status"];
      if (v != null) out.push(`${envAgg}#System Temperature Status`);
    }

    // PoE: Power Used (W)
    const poeUsed = `sensor.${prefix}_poe_power_used`;
    if (H[poeUsed]) out.push(poeUsed);
    else {
      const st = H[poeAgg];
      const v = st?.attributes?.["PoE Power Used (W)"];
      if (v != null) out.push(`${poeAgg}#PoE Power Used (W)`);
      else if (st) out.push(poeAgg); // fallback (state = used W)
    }

    // PoE: Power Available (W)  (remaining budget)
    const poeAvail = `sensor.${prefix}_poe_power_available`;
    if (H[poeAvail]) out.push(poeAvail);
    else {
      const st = H[poeAgg];
      const v = st?.attributes?.["PoE Power Available (W)"];
      if (v != null) out.push(`${poeAgg}#PoE Power Available (W)`);
    }

    return out;
  }

  _isAutoDefaultDiagKey(key) {
    // Used to remember when users remove an auto-default row so it doesn't come back.
    const k = String(key || "");
    return (
      /_system_temperature(_status)?$/.test(k) ||
      /_poe_power_(used|available)$/.test(k) ||
      /_environment#System Temperature/.test(k) ||
      /_power_over_ethernet#PoE Power (Used|Available)/.test(k) ||
      /_power_over_ethernet$/.test(k)
    );
  }

  _injectAutoDiagDefaults(order, enabledMap) {
    const H = this._hass?.states || {};
    const prefix = this._inferDevicePrefix();
    if (!prefix) return order;

    const defaults = this._autoDefaultDiagKeys(prefix, H);
    if (!defaults.length) return order;

    const out = Array.isArray(order) ? [...order] : [];
    for (const k of defaults) {
      // If user explicitly disabled/removed this key, don't re-add it.
      if (enabledMap && enabledMap[k] === false) continue;
      if (!out.includes(k)) out.push(k);
    }
    return out;
  }

  _entityMatchesNameUnitSlot(id, st) {
    const attrs = st?.attributes || {};
    const name = String(attrs.Name || id.split(".")[1] || "");
    if (this._config.device_name) {
      const needle = String(this._config.device_name).toLowerCase();
      const fn = String(attrs.friendly_name || "").toLowerCase();
      if (!fn.includes(needle) && !id.toLowerCase().includes(needle)) return false;
    }
    if (this._config.unit != null || this._config.slot != null) {
      const t = this._parseTriple(name); if (!t) return false;
      if (this._config.unit != null && t.unit !== this._config.unit) return false;
      if (this._config.slot != null && t.slot !== this._config.slot) return false;
    }
    return true;
  }

  async _discoverEntities() {
    const H = this._hass?.states || {};
    const explicit = false; // explicit ports feature removed; use Hide ports instead

    if (this._config.anchor_entity && !this._anchorDeviceId) {
      await this._resolveAnchorDeviceId();
      this._render(); // allow re-render
    }

    // Performance: avoid scanning the *entire* hass.states registry on every render.
    // When a device prefix is selected, cache the matching entity_ids and reuse them
    // as long as the state registry key-count is unchanged.
    let entries;
    if (!explicit && this._config.device) {
      const pref = `switch.${String(this._config.device)}_`;
      const keyCount = Object.keys(H).length;
      if (this._cachedDevicePrefix !== pref || this._cachedStatesKeyCount !== keyCount) {
        const ids = [];
        for (const id in H) {
          if (id.startsWith(pref)) ids.push(id);
        }
        this._cachedDevicePrefix = pref;
        this._cachedStatesKeyCount = keyCount;
        this._cachedDeviceEntityIds = ids;
      }
      const ids = Array.isArray(this._cachedDeviceEntityIds) ? this._cachedDeviceEntityIds : [];
      entries = ids.map(id => [id, H[id]]).filter(([, st]) => !!st);
    }

    entries = entries || (explicit
      ? this._config.ports.map(id => [id, H[id]]).filter(([, st]) => !!st)
      : Object.entries(H).filter(([id, st]) => {
          if (!id.startsWith("switch.")) return false;
          if (!st?.attributes) return false;

          const attrs = st.attributes;
          const looksRight =
            (attrs.Index !== undefined || attrs.Name) ||
            /^switch\.(?:gi|te|tw)\d+_\d+_\d+$/i.test(id) ||
            /^switch\.(?:vl\d+|lo\d+|po\d+)$/i.test(id);
          if (!looksRight) return false;

          // Preferred scoping: device hostname prefix (switch.<device>_*)
          // (Handled by the cached fast-path above when device is set.)
          if (this._config.device) {
            const pref = `switch.${String(this._config.device)}_`;
            if (!id.startsWith(pref)) return false;
            return true;
          }

          if (this._anchorDeviceId && this._entityReg) {
            const did = this._deviceIdForEntity(id);
            if (!did || did !== this._anchorDeviceId) return false;
          } else {
            if (!this._entityMatchesNameUnitSlot(id, st)) return false;
          }
          return true;
        }));

    if (!entries.length && !explicit) {
      const candidates = Object.keys(H).filter(k => k.startsWith("switch.")).slice(0, 20);
      return { phys: [], virt: [], diag: candidates };
    }

    const phys = [], virt = [];
    const _hideSet = _ssmNormListToSet(this._config?.hide_ports);
    const _virtSet = _ssmNormListToSet(this._config?.virtual_overrides);
    for (const [id, st] of entries) {
      const nRaw = String(st.attributes?.Name || id.split(".")[1] || "");
      const idKey = String(id).trim().toLowerCase();
      const n = nRaw.toUpperCase();
      if (_hideSet.size) {
        const nKey = String(nRaw).trim().toLowerCase();
        const idKey = String(id).trim().toLowerCase();
        if (_hideSet.has(nKey) || _hideSet.has(idKey)) continue;
      }
      // Virtual overrides (independent of visibility toggle)
      if (_virtSet && _virtSet.size) {
        const nKey2 = String(n).trim().toLowerCase();
        if (_virtSet.has(nKey2) || _virtSet.has(idKey)) {
          virt.push([id, st]);
          continue;
        }
      }
      const a = st.attributes || {};

      // Classification: use Port Type attribute from the integration (preferred).
      // - If Port Type is "unknown"/empty → default to VIRTUAL (cannot be classified).
      // - If the user configured Virtual interface overrides: everything NOT in the overrides list is treated as PHYSICAL.
      const portTypeRaw =
        (a["Port Type"] ?? a.PortType ?? a.port_type ?? a.portType ?? a.port_type_label ?? a.portTypeLabel ?? a.Type ?? a.type ?? "");
      const portType = String(portTypeRaw).trim().toLowerCase();

      let isPhysical = false;

      if (_virtSet && _virtSet.size) {
        // If we reach here, it wasn't matched as virtual above, so treat as physical.
        isPhysical = true;
      } else if (!portType || portType === "unknown" || portType === "-" || portType === "unavailable") {
        isPhysical = false;
      } else {
        // Be tolerant of common vendor spellings.
        if (portType === "physical" || portType === "phys") isPhysical = true;
        else if (portType === "virtual" || portType === "virt") isPhysical = false;
        else if (portType.includes("phys")) isPhysical = true;
        else if (portType.includes("virtual")) isPhysical = false;
        else isPhysical = false; // safest default
      }
      if (isPhysical) phys.push([id, st]);
      else virt.push([id, st]);
    }

    phys.sort((a, b) => {
      const na = a[1].attributes?.Name || a[0];
      const nb = b[1].attributes?.Name || b[0];
      const ta = this._parseTriple(na), tb = this._parseTriple(nb);
      const ka = this._kindPriority(ta?.kind), kb = this._kindPriority(tb?.kind);
      if (ka !== kb) return ka - kb;
      if ((ta?.unit ?? 1e9) !== (tb?.unit ?? 1e9)) return (ta?.unit ?? 1e9) - (tb?.unit ?? 1e9);
      if ((ta?.slot ?? 1e9) !== (tb?.slot ?? 1e9)) return (ta?.slot ?? 1e9) - (tb?.slot ?? 1e9);
      if ((ta?.port ?? 1e9) !== (tb?.port ?? 1e9)) return (ta?.port ?? 1e9) - (tb?.port ?? 1e9);
      return String(na).localeCompare(String(nb), undefined, { numeric: true, sensitivity: "base" });
    });

    virt.sort((a, b) => {
      const na = String(a[1].attributes?.Name || a[0]);
      const nb = String(b[1].attributes?.Name || b[0]);
      return na.localeCompare(nb, undefined, { numeric: true, sensitivity: "base" });
    });

    return { phys, virt, diag: null };
  }
  _defaultSpeedPalette() {
    // Default palette (consistent with README legend)
    return {
      "10 Mbps": "#9ca3af",      // gray
      "100 Mbps": "#f59e0b",     // orange
      "1 Gbps": "#22c55e",       // green
      "2.5 Gbps": "#14b8a6",     // teal
      "5 Gbps": "#0ea5e9",       // cyan
      "10 Gbps": "#3b82f6",      // blue
      "20 Gbps": "#6366f1",      // indigo
      "25 Gbps": "#8b5cf6",      // violet
      "40 Gbps": "#a855f7",      // purple
      "50 Gbps": "#d946ef",      // fuchsia
      "100 Gbps": "#ec4899",     // pink
      "Disconnected": "#ef4444", // red (was Unknown)
      "Admin Down": "#6b7280",   // gray (admin disabled)
      "Unknown": "#ef4444",      // legacy key
    };
  }

  _speedLabelFromMbps(mbps) {
    if (!mbps || !Number.isFinite(mbps)) return null;
    if (mbps === 10) return "10 Mbps";
    if (mbps === 100) return "100 Mbps";
    if (mbps === 1000) return "1 Gbps";
    if (mbps === 2500) return "2.5 Gbps";
    if (mbps === 5000) return "5 Gbps";
    if (mbps === 10000) return "10 Gbps";
    if (mbps === 20000) return "20 Gbps";
    if (mbps === 25000) return "25 Gbps";
    if (mbps === 40000) return "40 Gbps";
    if (mbps === 50000) return "50 Gbps";
    if (mbps === 100000) return "100 Gbps";
    return null;
  }

  _speedLabelFromAttrs(attrs) {
    if (!attrs) return null;

    // Prefer an already-normalized human string if the integration provides it.
    const candidates = [
      attrs.SpeedLabel, attrs.speed_label, attrs.speedLabel, attrs.speedText, attrs.speed_text, attrs.SpeedDisplay, attrs.speed_display, attrs.speedDisplay,
      attrs.LinkSpeedLabel, attrs.link_speed_label, attrs.LinkSpeedText, attrs.link_speed_text,
      attrs.PortSpeedLabel, attrs.port_speed_label,
      attrs.Speed, attrs.speed, attrs.PortSpeed, attrs.port_speed, attrs.link_speed, attrs.LinkSpeed,
      attrs.ifSpeed, attrs.if_speed
    ].filter(v => v != null);

    for (const raw of candidates) {
      if (typeof raw === "number" && Number.isFinite(raw)) {
        // Some integrations expose ifSpeed/link_speed as a number (bps). Treat large values as bps.
        // A value of 0 (or negative) is treated as a disconnected/no-link state.
        if (raw <= 0) return "Disconnected";
        const mbps = (raw > 100000) ? (raw / 1e6) : raw;
        return mbps;
      }
      if (typeof raw !== "string") continue;
      const s0 = raw.trim();
      if (!s0) continue;

      const s0l = s0.toLowerCase();
      if (s0l.includes("disconnected") || s0l.includes("notpresent") || s0l.includes("not present")) {
        return "Disconnected";
      }

      // Normalize formats like "2.5Gbps", "100Mbps", "1 Gbps", "10 mbps"
      const s = s0.replace(/\s+/g, " ").trim();
      const compact = s.toLowerCase().replace(/\s+/g, "");
      const m = compact.match(/^([0-9]+(?:\.[0-9]+)?)(m|g)bps$/);
      if (m) {
        const num = m[1];
        const unit = (m[2] === "g") ? "Gbps" : "Mbps";
        return `${num} ${unit}`;
      }

      // Already looks like "10 Mbps" / "1 Gbps"
      if (/^[0-9]+(?:\.[0-9]+)?\s*(m|g)bps$/i.test(s)) {
        const mm = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*(m|g)bps$/i);
        const num = mm[1];
        const unit = (mm[2].toLowerCase() === "g") ? "Gbps" : "Mbps";
        return `${num} ${unit}`;
      }
    }

    // Fall back to numeric parsing/heuristics.
    const mbps = this._parseSpeedMbps(attrs);
    return this._speedLabelFromMbps(mbps);
  }



  _colorFor(st) {
    if ((this._config?.color_mode || "state") === "speed") {
      const palette = this._defaultSpeedPalette();
      const attrs = st?.attributes || null;

      // Admin Down should win over speed/disconnected.
      const adminRaw = (attrs?.Admin ?? attrs?.admin_status ?? attrs?.admin ?? attrs?.ifAdminStatus ?? "").toString().toLowerCase();
      const operRaw = (attrs?.Oper ?? attrs?.oper_status ?? attrs?.oper ?? attrs?.ifOperStatus ?? "").toString().toLowerCase();
      const isAdminDown = adminRaw.includes("down") || adminRaw.includes("disabled") || adminRaw.includes("false") || adminRaw.includes("0");
      const isOperDown = operRaw.includes("down") || operRaw.includes("lowerlayerdown") || operRaw.includes("notpresent") || operRaw.includes("dormant") || operRaw.includes("unknown") || operRaw.includes("false") || operRaw.includes("0");

      // Prefer the integration's normalized human label when available.
      const label = isAdminDown ? "Admin Down" : (isOperDown ? "Disconnected" : (this._speedLabelFromAttrs(attrs) || "Disconnected"));

      // Per-speed override (stored in config) wins over defaults.
      const overrides = this._config?.speed_colors || null;
      const overrideColor = overrides && typeof overrides === "object" ? overrides[label] : null;
      if (typeof overrideColor === "string" && overrideColor.trim()) return overrideColor.trim();

      // Default palette.
      return palette[label] || palette["Disconnected"];
    }

    // Default: represent port state via Admin/Oper
    const palette = this._defaultStatePalette();
    const overrides = this._config?.state_colors && typeof this._config.state_colors === "object"
      ? this._config.state_colors
      : null;

    const a = String(st.attributes?.Admin || "").toLowerCase();
    const o = String(st.attributes?.Oper || "").toLowerCase();

    const key =
      (a === "up" && o === "up") ? "up_up" :
      (a === "up" && o === "down") ? "up_down" :
      (a === "down" && o === "down") ? "down_down" :
      (a === "up" && (o === "not present" || o === "not_present" || o === "notpresent")) ? "up_not_present" :
      null;

    const defColor = key ? (palette[key] || palette["up_not_present"]) : palette["up_not_present"];
    const overrideColor = key && overrides ? overrides[key] : null;
    if (typeof overrideColor === "string" && overrideColor.trim()) return overrideColor.trim();
    return defColor;
  }

  _defaultStatePalette() {
    // Defaults match the card's current state mode legend.
    return {
      "up_up": "#22c55e",           // Green — Admin: Up • Oper: Up
      "up_down": "#ef4444",         // Red — Admin: Up • Oper: Down
      "down_down": "#f59e0b",       // Orange — Admin: Down • Oper: Down
      "up_not_present": "#9ca3af",  // Gray — Admin: Up • Oper: Not Present
    };
  }



_parseSpeedMbps(attrs) {
  // Returns bucket Mbps values (10/100/1000/2500/5000/10000/...) or null.
  const a = attrs || {};
  const raw =
    a.Speed ?? a.speed ?? a.ifSpeed ?? a.ifspeed ?? a.if_speed ??
    a.ifHighSpeed ?? a.ifhighspeed ??
    a.PortSpeed ?? a.port_speed ?? a.link_speed ?? a.LinkSpeed ?? a.linkSpeed;

  if (raw == null || raw === "") return null;

  // String speeds: allow "1 Gbps", "100 Mbps", "2.5Gbps", and let "Disconnected" flow as non-numeric.
  if (typeof raw === "string") {
    const s = raw.trim();
    const sl = s.toLowerCase();
    if (!s) return null;
    if (sl.includes("disconnected") || sl.includes("notpresent") || sl.includes("not present") || sl === "down") {
      return null;
    }

    const mm = s.match(/([\d.]+)\s*([kmg]?)(?:b?ps)?/i);
    if (!mm) return null;
    const val = Number(mm[1]);
    if (!Number.isFinite(val) || val <= 0) return null;
    const unit = (mm[2] || "").toLowerCase();
    const mbps = unit == "g" ? val * 1000 : unit == "k" ? val / 1000 : val;
    return this._speedBucket(Math.round(mbps));
  }

  // Numeric: if it's very large, assume bps; else assume Mbps (covers ifHighSpeed which is often Mbps).
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const mbps = (n >= 1_000_000) ? Math.round(n / 1_000_000) : Math.round(n);
  return this._speedBucket(mbps);
}


  _speedBucket(mbps) {
    if (mbps === 10) return 10;
    if (mbps === 100) return 100;
    if (mbps === 1000) return 1000;
    if (mbps === 2500) return 2500;
    if (mbps === 5000) return 5000;
    if (mbps === 10000) return 10000;
    if (mbps === 20000) return 20000;
    if (mbps === 25000) return 25000;
    if (mbps === 40000) return 40000;
    if (mbps === 50000) return 50000;
    if (mbps === 100000) return 100000;
    return null;
  }

  _buttonLabel(st) {
    return (st.state || "").toLowerCase() === "on" ? "Turn off" : "Turn on";
  }


  _formatBitsPerSecond(v) {
    const n = Number(v);
    if (!isFinite(n)) return "-";
    const abs = Math.abs(n);
    const units = ["bit/s","Kbit/s","Mbit/s","Gbit/s","Tbit/s"];
    let u = 0;
    let val = abs;
    while (val >= 1000 && u < units.length - 1) { val /= 1000; u++; }
    const out = (val >= 100 ? val.toFixed(0) : val >= 10 ? val.toFixed(1) : val.toFixed(2));
    return `${n < 0 ? "-" : ""}${out} ${units[u]}`;
  }

  _formatBytes(v) {
    const n = Number(v);
    if (!isFinite(n)) return "-";
    const abs = Math.abs(n);
    const units = ["B","KB","MB","GB","TB","PB"];
    let u = 0;
    let val = abs;
    while (val >= 1024 && u < units.length - 1) { val /= 1024; u++; }
    const out = (val >= 100 ? val.toFixed(0) : val >= 10 ? val.toFixed(1) : val.toFixed(2));
    return `${n < 0 ? "-" : ""}${out} ${units[u]}`;
  }

  _findBandwidthForIfIndex(ifIndex) {
    const hass = this._hass;
    const idx = Number(ifIndex);
    if (!hass || !isFinite(idx)) return null;

    let rxBpsE=null, txBpsE=null, rxTotE=null, txTotE=null;
    for (const [eid, st] of Object.entries(hass.states || {})) {
      if (!eid.startsWith("sensor.")) continue;
      const a = st.attributes || {};
      if (Number(a.if_index) !== idx) continue;
      if (a.kind === "throughput") {
        if (a.direction === "rx") rxBpsE = eid;
        if (a.direction === "tx") txBpsE = eid;
      } else if (a.kind === "total") {
        if (a.direction === "rx") rxTotE = eid;
        if (a.direction === "tx") txTotE = eid;
      }
    }
    const rxBps = rxBpsE ? Number(hass.states[rxBpsE]?.state) : null;
    const txBps = txBpsE ? Number(hass.states[txBpsE]?.state) : null;
    const rxTot = rxTotE ? Number(hass.states[rxTotE]?.state) : null;
    const txTot = txTotE ? Number(hass.states[txTotE]?.state) : null;

    return { rxBpsE, txBpsE, rxTotE, txTotE, rxBps, txBps, rxTot, txTot };
  }

  _deviceDisplayNameByPrefix(prefix) {
    const p = String(prefix || "");
    const list = Array.isArray(this._snmpDevices) ? this._snmpDevices : [];
    const hit = list.find((d) => String(d.prefix) === p);
    return hit ? (hit.name || "") : "";
  }

  
  _stripDevicePrefix(label, deviceName, devicePrefix) {
    let s = String(label || "").trim();
    if (!s) return s;

    // Normalize helpers
    const norm = (v) => String(v || "").trim().toLowerCase();

    const dn = String(deviceName || "").trim();
    const dp = String(devicePrefix || "").trim();

    const candidates = [];
    if (dn) {
      candidates.push(dn);
      // Also include slugged forms of the display name (e.g., "Switch Study" -> "switch-study")
      const dnNorm = dn.trim().toLowerCase();
      const dnSlug = dnNorm.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const dnUnd = dnNorm.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      if (dnSlug) candidates.push(dnSlug);
      if (dnUnd) candidates.push(dnUnd);
    }

    if (dp) {
      // prefix as-is, plus common normalized variants
      candidates.push(dp);
      candidates.push(dp.replace(/[_-]+/g, " "));
      candidates.push(dp.replace(/_/g, "-"));
      candidates.push(dp.replace(/-/g, "_"));
    }

    // Collapse any immediate duplicated leading token first (e.g., "switch-study switch-study ...")
    s = s.replace(/^(\S+)\s+\1\s+/i, "$1 ").trim();

    // Remove any leading candidate like "<prefix> " or "<prefix> - " or "<prefix>: "
    for (const cand of candidates) {
      const c = String(cand || "").trim();
      if (!c) continue;
      const esc = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re1 = new RegExp("^" + esc + "\\s*[-–:]?\\s*", "i");
      s = s.replace(re1, "").trim();
    }

    // If it still starts with a duplicated token (e.g., "switch-study switch-study ..."), collapse it.
    s = s.replace(/^(\S+)\s+\1\s+/i, "$1 ").trim();

    return s;
  }




  async _openBandwidthGraphDialog(title, rxEntityId, txEntityId, force = false) {
    if (!this._hass || !rxEntityId || !txEntityId) return;

    // Bandwidth entities update frequently. If we allow the main card to
    // re-render while this modal is open, the statistics-graph element gets
    // torn down/re-attached repeatedly which looks like the lines are
    // constantly redrawing. Freeze the main render loop until the user closes
    // the graph (or explicitly presses Refresh).
    this._freezeRenderWhileGraphOpen = true;

    // Remove any prior graph modal
    if (this._graphAutoRefreshTimer) { clearInterval(this._graphAutoRefreshTimer); this._graphAutoRefreshTimer = null; }
    this._graphModalEl?.remove();
    this._graphModalStyle?.remove();

    const root = document.createElement("div");
    // Use a dedicated class so we can safely raise z-index above the port modal.
    root.className = "ssm-modal-root ssm-graph-modal-root";

    // Persist reference so we can re-attach after card re-renders.
    // This card uses `shadowRoot.innerHTML = ...` on updates, which would
    // otherwise wipe the dialog after a second or two when HA pushes state.
    this._bandwidthGraphModalRoot = root;

    root.innerHTML = `
      <div class="ssm-backdrop"></div>
      <div class="ssm-modal" role="dialog" aria-modal="true">
        <div class="ssm-modal-title">${title} – Bandwidth</div>
        <div class="ssm-modal-body"><div class="ssm-graph-host">Loading…</div></div>
        <div class="ssm-modal-actions">
          <div class="ssm-graph-refresh-wrap">
            <span class="ssm-graph-refresh-label">Auto refresh</span>
            <select class="ssm-graph-refresh" data-graph-auto-refresh="1">
              <option value="0">Never</option>
              <option value="5">5s</option>
              <option value="10">10s</option>
              <option value="30">30s</option>
              <option value="60">1m</option>
              <option value="300">5m</option>
            </select>
          </div>
          <button class="btn" data-refresh-graph="1">Refresh</button>
          <button class="btn subtle" data-close-graph="1">Close</button>
        </div>
      </div>
    `;

    const style = document.createElement("style");
    // Keep this scoped to the graph modal only.
    style.textContent = `
      .ssm-graph-modal-root{z-index:12000;}
      .ssm-graph-modal-root .ssm-backdrop{position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:12000;}
      .ssm-graph-modal-root .ssm-modal{position:fixed;z-index:12001;left:50%;top:50%;transform:translate(-50%,-50%);
        min-width:320px;width:90vw;max-width:900px;background:var(--card-background-color);
        color:var(--primary-text-color);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,0.5);padding:16px;}
      .ssm-graph-modal-root .ssm-modal-title{font-weight:700;font-size:18px;margin-bottom:8px}
      .ssm-graph-modal-root .ssm-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
      .ssm-graph-modal-root .btn{font:inherit;padding:8px 12px;border-radius:10px;border:1px solid var(--divider-color);
        background:var(--secondary-background-color);cursor:pointer}
      .ssm-graph-modal-root .btn.subtle{background:transparent}
      .ssm-graph-host{min-height:260px;width:100%;}
      .ssm-graph-host > *{width:100%;}
      .ssm-graph-host > *{width:100%;}
    
      .ssm-graph-refresh-wrap{display:flex;align-items:center;gap:6px;margin-right:auto;}
      .ssm-graph-refresh-label{font-size:12px;opacity:.85;}
      .ssm-graph-refresh{min-width:150px;max-width:180px;}
`;

    // NOTE: This modal lives inside the card's shadowRoot, so its styles must also live there.
    // Appending the <style> to document.body will NOT apply to shadow DOM.
    root.prepend(style);
    this.shadowRoot.appendChild(root);

    this._graphModalEl = root;
    this._graphModalStyle = style;

    const close = () => {
      if (this._graphAutoRefreshTimer) { clearInterval(this._graphAutoRefreshTimer); this._graphAutoRefreshTimer = null; }
      root.remove();
      style.remove();
      this._graphModalEl = null;
      this._graphModalStyle = null;
      this._bandwidthGraphModalRoot = null;
      this._graphCardEl = null;
      this._freezeRenderWhileGraphOpen = false;
      // Resume normal rendering now that the graph is closed
      this._render();
    };
    root.querySelector(".ssm-backdrop")?.addEventListener("click", close);
    root.querySelector('[data-close-graph="1"]')?.addEventListener("click", close);
    root
      .querySelector('[data-refresh-graph="1"]')
      ?.addEventListener("click", () =>
        this._openBandwidthGraphDialog(title, rxEntityId, txEntityId, true)
      );
    const host = root.querySelector(".ssm-graph-host");

const renderGraph = async (forceRebuild = false) => {
  // Reuse existing graph card unless explicitly refreshed
  if (!forceRebuild && this._graphCardEl) {
    host.textContent = "";
    host.appendChild(this._graphCardEl);
    return;
  }
  try {
    const helpers = await window.loadCardHelpers?.();
    if (!helpers) throw new Error("card helpers unavailable");
    const deviceName = this._deviceDisplayNameByPrefix(this._config?.device);

    const rxFriendly = this._hass?.states?.[rxEntityId]?.attributes?.friendly_name || "";
    const txFriendly = this._hass?.states?.[txEntityId]?.attributes?.friendly_name || "";

    const rxName = this._stripDevicePrefix(rxFriendly, deviceName, this._config?.device) || "RX Throughput";
    const txName = this._stripDevicePrefix(txFriendly, deviceName, this._config?.device) || "TX Throughput";

    const card = await helpers.createCardElement({
      type: "statistics-graph",
      chart_type: "line",
      period: "5minute",
      entities: [
        { entity: rxEntityId, name: rxName },
        { entity: txEntityId, name: txName },
      ],
      stat_types: ["mean", "max", "min"],
      title: `${title} Throughput`,
      hide_legend: false,
      logarithmic_scale: false,
    });
    card.hass = this._hass;
    host.textContent = "";
    host.appendChild(card);
    this._graphCardEl = card;
  } catch (e) {
    host.textContent = "Unable to load graph.";
    // eslint-disable-next-line no-console
    console.warn("SNMP Switch Manager Card: graph failed", e);
  }
};

root
  .querySelector('[data-refresh-graph="1"]')
  ?.addEventListener("click", () => renderGraph(true));

const selAuto = root.querySelector('[data-graph-auto-refresh="1"]');
if (selAuto) {
  // Load last value from localStorage (persisted per-browser)
  const stored = Number(window.localStorage.getItem("ssm_graph_refresh_sec") || "0");
  const last = Number.isFinite(stored) ? stored : (Number(this._graphAutoRefreshSec) || 0);
  selAuto.value = String(Number.isFinite(last) ? last : 0);

  const applyAuto = (sec) => {
    const n = Number(sec) || 0;
    this._graphAutoRefreshSec = n;
    window.localStorage.setItem("ssm_graph_refresh_sec", String(n));
    if (this._graphAutoRefreshTimer) {
      clearInterval(this._graphAutoRefreshTimer);
      this._graphAutoRefreshTimer = null;
    }
    if (n > 0) {
      this._graphAutoRefreshTimer = setInterval(() => {
        try { renderGraph(true); } catch (_) {}
      }, n * 1000);
    }
  };

  const onAutoChanged = (ev) => {
    const sec = Number(ev?.target?.value) || 0;
    applyAuto(sec);
  };

  selAuto.addEventListener("change", onAutoChanged);
  // Apply once on open so it starts immediately if previously enabled
  applyAuto(last);
}

renderGraph(force);
  }

  _toggle(entity_id) {
    const st = this._hass?.states?.[entity_id]; if (!st) return;
    const on = (st.state || "").toLowerCase() === "on";
    this._hass.callService("switch", on ? "turn_off" : "turn_on", { entity_id });
  }

  // HTML escape helper (used for SVG title text)
  _htmlEscape(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // helper to call the set_port_description service
  _updateAlias(entity_id, alias) {
    if (!this._hass || !entity_id) return;
    const description = (alias ?? "").trim();
    this._hass.callService("snmp_switch_manager", "set_port_description", {
      entity_id,
      description,
    });
  }

  // shared prompt for alias editing
  _promptAlias(entity_id, currentAlias) {
    const st = this._hass?.states?.[entity_id];
    const base = st?.attributes?.Alias ?? "";
    const current = currentAlias != null ? currentAlias : base;
    const next = window.prompt("Set port alias", current);
    if (next === null) return null; // cancelled
    this._updateAlias(entity_id, next);
    return next;
  }


  _maybeOpenBandwidthGraphForPort(entity_id) {
    // Only used for the "Speed colors" click behavior toggle.
    const hass = this._hass;
    if (!hass || !entity_id) return false;

    const baseObj = String(entity_id).split(".")[1] || "";
    if (!baseObj) return false;

    const rxEntityId = `sensor.${baseObj}_rx_throughput`;
    const txEntityId = `sensor.${baseObj}_tx_throughput`;

    // Only open if both sensors exist.
    if (!hass.states?.[rxEntityId] || !hass.states?.[txEntityId]) return false;

    const st = hass.states[entity_id];
    const attrs = st?.attributes || {};
    const title = attrs.Name || baseObj;

    // Fire and forget; dialog handles its own async rendering.
    this._openBandwidthGraphDialog(title, rxEntityId, txEntityId);
    return true;
  }


  _openDialog(entity_id) {
    const st = this._hass?.states?.[entity_id]; if (!st) return;
    const attrs = st.attributes || {};
    const name = attrs.Name || entity_id.split(".")[1];
    const ip = attrs.IP ? `<div><b>IP:</b> ${attrs.IP}</div>` : "";
    const speed = attrs.Speed ?? attrs.speed ?? attrs.ifSpeed;
    const vlan = attrs["VLAN ID"] ?? attrs.vlan_id ?? attrs.VLAN_ID ?? attrs.VLAN ?? attrs.vlan;
    const aliasValue = attrs.Alias ?? "";

    // Bandwidth sensors are named to match the base switch entity_id, e.g.:
    //   switch.switch_study_gi1_0_1
    //   sensor.switch_study_gi1_0_1_rx_throughput
    // Only show RX/TX/Graph if the sensors exist *and* have numeric state.
    const baseObj = (entity_id || "").split(".")[1] || "";
    const rxRateE = baseObj ? `sensor.${baseObj}_rx_throughput` : null;
    const txRateE = baseObj ? `sensor.${baseObj}_tx_throughput` : null;
    const rxTotE = baseObj ? `sensor.${baseObj}_rx_total` : null;
    const txTotE = baseObj ? `sensor.${baseObj}_tx_total` : null;

    const _numState = (eid) => {
      if (!eid) return null;
      const st2 = this._hass?.states?.[eid];
      if (!st2) return null;
      const s = (st2.state ?? "").toString();
      const sl = s.toLowerCase();
      if (sl === "unknown" || sl === "unavailable" || sl === "") return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    };

    const rxBps = _numState(rxRateE);
    const txBps = _numState(txRateE);
    const rxTot = _numState(rxTotE);
    const txTot = _numState(txTotE);
    const hasRates = (rxBps != null) && (txBps != null);

    const rxRate = (rxBps != null) ? this._formatBitsPerSecond(rxBps) : "-";
    const txRate = (txBps != null) ? this._formatBitsPerSecond(txBps) : "-";
    const rxTotS = (rxTot != null) ? this._formatBytes(rxTot) : "-";
    const txTotS = (txTot != null) ? this._formatBytes(txTot) : "-";
    const canGraph = hasRates;

    // remove any prior modal/style
    this._modalEl?.remove(); this._modalStyle?.remove();
    this._modalEntityId = entity_id;

    this._modalEl = document.createElement("div");
    this._modalEl.className = "ssm-modal-root";
    // Build modal rows (hide blank VLAN fields)
    const _isBlank = (v) => {
      if (v === null || v === undefined) return true;
      if (Array.isArray(v)) return v.length === 0;
      const s = String(v).trim();
      if (s === "") return true;
      const sl = s.toLowerCase();
      return sl === "unknown" || sl === "unavailable" || sl === "none" || sl === "null";
    };
    const _first = (...vals) => {
      for (const v of vals) {
        if (!_isBlank(v)) return v;
      }
      return null;
    };
    const vlanId = _first(
      attrs["VLAN ID"], attrs.vlan_id, attrs.VLAN_ID, attrs.VLAN, attrs.vlan
    );
    const nativeVlan = _first(
      attrs["Native VLAN"], attrs.native_vlan, attrs.NativeVlan, attrs.nativeVlan
    );
    const allowedVlans = _first(
      attrs["Allowed VLANs"], attrs.allowed_vlans, attrs.AllowedVlans, attrs.allowedVlans
    );
    const untaggedVlans = _first(
      attrs["Untagged VLANs"], attrs.untagged_vlans, attrs.UntaggedVlans, attrs.untaggedVlans
    );
    const taggedVlans = _first(
      attrs["Tagged VLANs"], attrs.tagged_vlans, attrs.TaggedVlans, attrs.taggedVlans,
      attrs["Taggged VLANs"], attrs.taggged_vlans // tolerate misspelling
    );
    const trunk = _first(
      attrs["Trunk"], attrs.trunk, attrs.is_trunk, attrs.IsTrunk
    );

    const _row = (label, value) => {
      if (_isBlank(value)) return "";
      return `<div><b>${label}</b> ${value}</div>`;
    };

        const _prettyKey = (k) => String(k || "")
      .replace(/_/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/\s+/g, " ")
      .trim();

    const _normAttrVal = (v) => {
      if (Array.isArray(v)) return v.join(", ");
      if (v && typeof v === "object") {
        try {
          const s = JSON.stringify(v);
          // Avoid huge blobs in the UI
          return (s.length > 300) ? (s.slice(0, 300) + "…") : s;
        } catch (e) {
          return String(v);
        }
      }
      return v;
    };

    const rows = [];
    const used = new Set(["name", "alias", "friendly_name", "friendly name", "icon"]);

    const _add = (key, label, value) => {
      if (_isBlank(value)) return;
      rows.push(_row(label, _normAttrVal(value)));
      if (key) used.add(String(key).toLowerCase());
    };

    // Common, high-signal fields first (vendor neutral)
    _add("admin", "Admin:", attrs.Admin);
    _add("oper", "Oper:", attrs.Oper);
    _add("speed", "Speed:", attrs.Speed);
    _add("duplex", "Duplex:", attrs.Duplex);
    _add("poe", "PoE:", attrs.PoE ?? attrs.Poe ?? attrs.POE);

    // Per-interface PoE in Sensors mode: show PoE sensor value (like bandwidth sensors)
    // when the switch port entity does not expose a PoE attribute but a PoE sensor exists.
    if (_isBlank(attrs.PoE ?? attrs.Poe ?? attrs.POE) && baseObj) {
      const H = this._hass?.states || {};
      const prefix = `sensor.${baseObj}_`;

      // Prefer common, explicit PoE sensor suffixes if present.
      const preferred = [
        `sensor.${baseObj}_poe_power`,
        `sensor.${baseObj}_poe`,
        `sensor.${baseObj}_poe_watts`,
        `sensor.${baseObj}_poe_draw`,
        `sensor.${baseObj}_poe_consumption`,
        `sensor.${baseObj}_poe_usage`,
        `sensor.${baseObj}_poe_used`,
        `sensor.${baseObj}_poe_output`,
        `sensor.${baseObj}_poe_load`,
      ];

      const _validSensor = (eid) => {
        const stx = H[eid];
        if (!stx) return null;
        const s = (stx.state ?? "").toString();
        const sl = s.toLowerCase();
        if (sl === "unknown" || sl === "unavailable" || sl === "") return null;
        const u = stx.attributes?.unit_of_measurement;
        return `${s}${u ? ` ${u}` : ""}`;
      };

      let poeVal = null;
      for (const eid of preferred) {
        poeVal = _validSensor(eid);
        if (poeVal) break;
      }

      // Fallback: find any sensor for this port that contains "poe".
      if (!poeVal) {
        const candidates = Object.keys(H)
          .filter((k) => k.startsWith(prefix) && k.includes("poe"))
          .sort((a, b) => {
            // Put "power"-like sensors first.
            const ap = a.includes("power") ? 0 : 1;
            const bp = b.includes("power") ? 0 : 1;
            if (ap !== bp) return ap - bp;
            return a.localeCompare(b);
          });
        for (const eid of candidates) {
          poeVal = _validSensor(eid);
          if (poeVal) break;
        }
      }

      if (poeVal) {
        _add("poe_sensor", "PoE:", poeVal);
      }
    }

    // Bandwidth sensors (non-attribute info) — derived from switch port entity_id base.
    // This stays stable even if the user changes port display names via rename rules.
    const hass = this._hass;
    const hasBwSensors =
      (rxRateE && hass?.states?.[rxRateE]) ||
      (txRateE && hass?.states?.[txRateE]) ||
      (rxTotE && hass?.states?.[rxTotE]) ||
      (txTotE && hass?.states?.[txTotE]);

    if (hasBwSensors) {
      const rxLine = (rxRate != null && rxRate !== "-")
        ? `${rxRate}${(rxTotS != null && rxTotS !== "-") ? ` (${rxTotS})` : ""}`
        : "-";
      const txLine = (txRate != null && txRate !== "-")
        ? `${txRate}${(txTotS != null && txTotS !== "-") ? ` (${txTotS})` : ""}`
        : "-";

      _add("rx", "RX:", rxLine);
      _add("tx", "TX:", txLine);
    }


    // VLAN / trunk fields (use normalized computed values where available)
    _add("vlan id", "VLAN ID:", vlanId);
    _add("native vlan", "Native VLAN:", nativeVlan);
    _add("allowed vlans", "Allowed VLANs:", allowedVlans);
    _add("untagged vlans", "Untagged VLANs:", untaggedVlans);
    _add("tagged vlans", "Tagged VLANs:", taggedVlans);
    if (!_isBlank(trunk)) {
      _add("trunk", "Trunk:", (typeof trunk === "boolean") ? (trunk ? "true" : "false") : trunk);
    }

    // Addressing / index
    _add("ip", "IP:", attrs.IP);
    _add("index", "Index:", (attrs.Index ?? "-"));

    // Then show every remaining attribute (excluding Name/Alias) in a stable order
    const extraEntries = Object.entries(attrs || {})
      .filter(([k, v]) => !used.has(String(k).toLowerCase()) && !_isBlank(v))
      .filter(([k, v]) => {
        // Skip some noisy/internal keys if they ever appear
        const kl = String(k).toLowerCase();
        return !(kl === "entity_id" || kl === "device" || kl === "ports" || kl === "friendly_name" || kl === "friendly name" || kl === "icon");
      })
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

    for (const [k, v] of extraEntries) {
      rows.push(_row(_prettyKey(k) + ":", _normAttrVal(v)));
    }

    const rowsHtml = rows.join("");

    this._modalEl.innerHTML = `
      <div class="ssm-backdrop"></div>
      <div class="ssm-modal" role="dialog" aria-modal="true">
        <div class="ssm-modal-title">${name}</div>
        <div class="ssm-modal-body">
          ${rowsHtml}
          <div>
            <b>Alias:</b>
            <span class="alias-text">${aliasValue || "-"}</span>
            <button class="btn small" data-alias-edit="${entity_id}">Edit</button>
          </div>
        </div>
        <div class="ssm-modal-actions">
          ${this._config.hide_control_buttons ? "" : `<button class="btn wide" data-entity="${entity_id}">${this._buttonLabel(st)}</button>`}
          ${canGraph ? `<button class="btn subtle" data-bw-graph="1">Graph</button>` : ``}
          <button class="btn subtle" data-close="1">Close</button>
        </div>
      </div>
    `;

    // Persist this stylesheet across renders too
    this._modalStyle = document.createElement("style");
    this._modalStyle.textContent = `
      .ssm-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;}
      .ssm-modal{position:fixed;z-index:10001;left:50%;top:50%;transform:translate(-50%,-50%);
        min-width:320px;max-width:90vw;background:var(--card-background-color);
        color:var(--primary-text-color);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.5);padding:16px;}
      .ssm-modal-title{font-weight:700;font-size:18px;margin-bottom:8px}
      .ssm-modal-body div{margin:4px 0}
      .ssm-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
      .btn{font:inherit;padding:8px 12px;border-radius:10px;border:1px solid var(--divider-color);
        background:var(--secondary-background-color);cursor:pointer}
      .btn.wide{flex:1;text-align:center}
      .btn.subtle{background:transparent}
      .btn.small{padding:4px 8px;font-size:12px}
    `;

    const close = () => {
      this._modalEl?.remove(); this._modalStyle?.remove();
      this._modalEl = null; this._modalStyle = null;
      this._modalEntityId = null;
    };

    const backdrop = this._modalEl.querySelector(".ssm-backdrop");
    if (backdrop) {
      backdrop.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        close();
      });
    }

    const closeBtn = this._modalEl.querySelector("[data-close]");
    if (closeBtn) {
      closeBtn.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        close();
      });
    }

    this._modalEl.querySelector(".ssm-modal")?.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
    });

    // Edit alias via prompt (shared helper)
    const graphBtn = this._modalEl.querySelector("[data-bw-graph]");
    if (graphBtn && canGraph) {
      graphBtn.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this._openBandwidthGraphDialog(name, rxRateE, txRateE);
      });
    }

    const editBtn = this._modalEl.querySelector("[data-alias-edit]");
    if (editBtn) {
      editBtn.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const updated = this._promptAlias(entity_id, aliasValue);
        if (updated === null) return;
        const span = this._modalEl?.querySelector(".alias-text");
        if (span) span.textContent = updated || "-";
      });
    }

    const toggleBtn = this._modalEl.querySelector(".btn.wide");
    if (toggleBtn) {
      toggleBtn.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const id = ev.currentTarget.getAttribute("data-entity");
        this._toggle(id);
        // button label will update automatically on next hass state change
      });
    }

    // Append both style and modal
    this.shadowRoot.append(this._modalStyle, this._modalEl);
  }

  _reattachTransientModals() {
    // This card re-renders on every hass update and rewrites shadowRoot.innerHTML.
    // That wipes any imperatively-added dialogs unless we re-attach them.
    if (this._bandwidthGraphModalRoot && !this._bandwidthGraphModalRoot.isConnected) {
      this.shadowRoot.appendChild(this._bandwidthGraphModalRoot);
    }
  }


  // ---------- calibration helper (panel view) ----------
  _copyToClipboard(text) {
    try {
      if (navigator?.clipboard?.writeText) return navigator.clipboard.writeText(text);
    } catch (e) {}
    // fallback
    try { window.prompt("Copy to clipboard:", text); } catch (e) {}
    return Promise.resolve();
  }

  _svgPoint(svg, clientX, clientY) {
    if (!svg || typeof svg.createSVGPoint !== "function") return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    return pt.matrixTransform(ctm.inverse());
  }


  _calibStorageKey() {
    // Persist layout between re-renders / card re-instantiation (e.g. in the UI editor preview).
    // Key is scoped per device prefix + background image so different devices/images don't collide.
    // IMPORTANT: Do NOT include title (changing title should not break persistence).
    const prefix = this._inferDevicePrefix() || "unknown";
    const bg = String(this._config?.background_image || "");
    return `ssm_calib_v2:${prefix}:${bg}`;
  }

  _loadCalibMapFromStorage() {
    try {
      const key = this._calibStorageKey();
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const obj = JSON.parse(raw);

      // Backward compatible: older versions stored the map directly.
      if (obj && typeof obj === "object" && !("map" in obj) && !("ts" in obj) && !("v" in obj)) {
        return { v: 1, ts: 0, map: obj };
      }

      if (obj && typeof obj === "object" && obj.map && typeof obj.map === "object") {
        const upl = (obj.uplink_box && typeof obj.uplink_box === "object") ? obj.uplink_box : null;
        const pb = (obj.ports_box && typeof obj.ports_box === "object") ? obj.ports_box : null;
        const po = (typeof obj.ports_order === "string") ? obj.ports_order : null;
        return { v: Number(obj.v) || 2, ts: Number(obj.ts) || 0, map: obj.map, uplink_box: upl, ports_box: pb, ports_order: po };
      }

      return null;
    } catch (e) {
      return null;
    }
  }

  _persistCalibMapToStorage() {
    try {
      const key = this._calibStorageKey();
      const map = (this._calibMap && typeof this._calibMap === "object") ? this._calibMap : {};
      const obj = {
        v: 2,
        ts: Date.now(),
        map,
        uplink_box: (this._calibUplinkBox && typeof this._calibUplinkBox === "object") ? this._calibUplinkBox : null,
        ports_box: (this._calibPortsBox && typeof this._calibPortsBox === "object") ? this._calibPortsBox : null,
        ports_order: (typeof this._calibPortsOrder === "string" && this._calibPortsOrder) ? this._calibPortsOrder : "numeric",
      };
      localStorage.setItem(key, JSON.stringify(obj));
    } catch (e) {}
  }

  _persistCalibMapDebounced() {
    // IMPORTANT: Do NOT persist layout positions automatically.
    // The user expects positions to be saved ONLY when clicking the Save button
    // in the Layout Editor.
    // Keep this method as a no-op for backward compatibility with older code paths.
    return;
  }

_isCalibrationEnabled() {
  const enabled = !!this._config?.calibration_mode;
  if (!enabled) return false;

  // If the user clicked Exit, persist a "force off" flag so it stays off on the dashboard
  // until explicitly re-enabled in the card editor.
  try {
    const prefix = this._config?.device ? String(this._config.device) : "all";
    const k = `ssm_calib_force_off:${prefix}`;
    if (localStorage.getItem(k)) return false;
  } catch (e) {}

  return true;
}


  _setupCalibrationUI() {
    const enabled = this._isCalibrationEnabled();

    // Clear any prior calibration state when disabled
    if (!enabled) {
      this._calibSelected = null;
      this._calibSel = null;
      this._calibMap = null;
      this._calibDirty = false;
      this._calibSnap = 0;
      this._calibAssist = null;
      this._calibAssistPt1 = null;
      this._freezeRenderWhileCalibrationActive = false;
      this._calibUplinkBox = null;
      this._calibUplinkBoxMode = false;
      this._calibPortsBox = null;
      this._calibPortsBoxMode = false;
      this._calibPortsOrder = null;
      return;
    }

    const root = this.shadowRoot;
    const svg = root?.querySelector("svg[data-ssm-panel]");
    if (!svg) return;

    // Freeze re-renders from hass churn while calibration mode is active.
    // Rebuilding the shadow DOM cancels pointer capture mid-drag and causes selection/textarea churn.
    this._freezeRenderWhileCalibrationActive = true;

    // Init map from config once, then keep it across renders while calibration mode is enabled.
    if (!this._calibMap) {
      const stored = this._loadCalibMapFromStorage();
      if (stored && stored.map) {
        this._calibMap = stored.map;
        if (!this._calibPortsOrder && stored.ports_order) {
          this._calibPortsOrder = String(stored.ports_order);
        }
        if (!this._calibUplinkBox && stored.uplink_box && typeof stored.uplink_box === "object") {
          this._calibUplinkBox = stored.uplink_box;
        }
        if (!this._calibPortsBox && stored.ports_box && typeof stored.ports_box === "object") {
          this._calibPortsBox = stored.ports_box;
        }
      } else {
        const raw = (this._config.port_positions && typeof this._config.port_positions === "object") ? this._config.port_positions : {};
        this._calibMap = JSON.parse(JSON.stringify(raw || {}));
      }
    this._calibDirty = false;
    }

    // Selection + snap state
    this._calibSel = this._calibSel || new Set();
    this._calibSnap = Number.isFinite(this._calibSnap) ? this._calibSnap : 0;
    this._calibAssist = this._calibAssist || null;
    this._calibAssistPt1 = this._calibAssistPt1 || null;
    this._calibPortsOrder = (typeof this._calibPortsOrder === "string" && this._calibPortsOrder) ? this._calibPortsOrder : "numeric";

    const elXY = root.getElementById("ssm-calib-xy");
    const elSelCount = root.getElementById("ssm-calib-selected-count");
    const elMsg = root.getElementById("ssm-calib-msg");
    const elSnap = root.getElementById("ssm-calib-snap");
    const elOrder = root.getElementById("ssm-calib-order");
    const elAdv = root.getElementById("ssm-calib-advanced");
    const elAdvToggle = root.getElementById("ssm-calib-advanced-toggle");
    const elJson = root.getElementById("ssm-calib-json");
    const marquee = root.getElementById("ssm-calib-marquee");
    const portsBtn = root.getElementById("ssm-calib-portsbox");
    const portsRect = root.getElementById("ssm-portsbox-rect");
    const portsLayer = root.getElementById("ssm-portsbox-layer");
    const portsHandles = Array.from(root.querySelectorAll(".ssm-portsbox-handle"));
    const uplBtn = root.getElementById("ssm-calib-uplinkbox");
    const uplRect = root.getElementById("ssm-uplinkbox-rect");
    const uplLayer = root.getElementById("ssm-uplinkbox-layer");
    const uplHandles = Array.from(root.querySelectorAll(".ssm-uplinkbox-handle"));

    const setMsg = (txt) => {
      if (!elMsg) return;
      elMsg.textContent = txt ? ` • ${txt}` : "";
    };

    const refreshSelCount = () => {
      if (elSelCount) elSelCount.textContent = String(this._calibSel?.size || 0);
    };

    const refreshSelectionStyles = () => {
      const sel = this._calibSel || new Set();
      root.querySelectorAll('.port-svg[data-entity]').forEach(pg => {
        const id = pg.getAttribute('data-entity');
        if (id && sel.has(id)) pg.classList.add('calib-selected');
        else pg.classList.remove('calib-selected');
      });
    };

    const getPortRect = (g) => g?.querySelector("rect");
    const getGXY = (g) => {
      const r = getPortRect(g);
      if (!r) return null;
      const x = parseFloat(r.getAttribute("x"));
      const y = parseFloat(r.getAttribute("y"));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x, y };
    };

    const applySnap = (v) => {
      const s = Number(this._calibSnap || 0);
      if (!s || !Number.isFinite(s) || s <= 0) return v;
      return Math.round(v / s) * s;
    };

    const setPortXY = (entityId, x, y) => {
      if (!this._calibMap) this._calibMap = {};
      // IMPORTANT: Persist positions keyed by PORT NAME (interface name), not entity_id.
      // The card's layout application logic expects port_positions keys to match interface names.
      const g = root.querySelector(`.port-svg[data-entity="${CSS.escape(entityId)}"]`);
      const portName = (g && g.getAttribute("data-portname")) ? String(g.getAttribute("data-portname")).trim() : "";
      const key = portName || entityId;
      this._calibMap[key] = { x, y };
      const r = getPortRect(g);
      if (r) {
        const oldX = Number(r.getAttribute("x") || "0");
        const oldY = Number(r.getAttribute("y") || "0");
        r.setAttribute("x", String(x));
        r.setAttribute("y", String(y));
        const dx = x - oldX;
        const dy = y - oldY;
        if (Number.isFinite(dx) && Number.isFinite(dy) && (dx !== 0 || dy !== 0)) {
          const t = root.querySelector(`text.portlabel[data-entity="${CSS.escape(entityId)}"]`);
          if (t) {
            const tx = Number(t.getAttribute("x") || "0") + dx;
            const ty = Number(t.getAttribute("y") || "0") + dy;
            t.setAttribute("x", String(tx));
            t.setAttribute("y", String(ty));
          }
          const bg = root.querySelector(`rect.portlabel-bg[data-entity="${CSS.escape(entityId)}"]`);
          if (bg) {
            const bx = Number(bg.getAttribute("x") || "0") + dx;
            const by = Number(bg.getAttribute("y") || "0") + dy;
            bg.setAttribute("x", String(bx));
            bg.setAttribute("y", String(by));
          }
        }
      }
    };

    const refreshExport = () => {
      if (!elJson) return;
      const obj = (this._calibMap && typeof this._calibMap === "object") ? this._calibMap : {};
      elJson.value = JSON.stringify(obj, null, 2);
    };

    const clearMarquee = () => {
      if (!marquee) return;
      marquee.style.display = "none";
      marquee.setAttribute("width", "0");
      marquee.setAttribute("height", "0");
    };

    const normBox = (b) => {
      if (!b || typeof b !== "object") return null;
      const x = Number(b.x); const y = Number(b.y);
      const w = Number(b.w); const h = Number(b.h);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
      return { x, y, w: Math.max(10, w), h: Math.max(10, h) };
    };

    // -----------------------------
    // Layout Editor: Undo / Redo
    // -----------------------------
    // Stores in-memory history only while the Layout Editor is open.
    const _calibHist = this._calibHist || (this._calibHist = { undo: [], redo: [], pending: null });
    const MAX_HIST = 50;

    const snapshotLayout = () => {
      const snap = {
        map: (this._calibMap && typeof this._calibMap === "object") ? this._calibMap : {},
        portsBox: this._calibPortsBox || null,
        uplinkBox: this._calibUplinkBox || null,
        portsOrder: this._calibPortsOrder || "numeric",
        snap: this._calibSnap || 0,
      };
      // JSON round-trip ensures a deep copy and keeps history small.
      return JSON.stringify(snap);
    };

    const applySnapshot = (snapStr) => {
      if (!snapStr) return;
      let snap;
      try { snap = JSON.parse(snapStr); } catch (e) { return; }

      this._calibMap = (snap?.map && typeof snap.map === "object") ? snap.map : {};
      this._calibPortsBox = snap?.portsBox || null;
      this._calibUplinkBox = snap?.uplinkBox || null;
      this._calibPortsOrder = snap?.portsOrder || "numeric";
      this._calibSnap = snap?.snap || 0;

      // Apply map -> SVG immediately
      const gs = Array.from(root.querySelectorAll('.port-svg[data-entity]'));
      gs.forEach(g => {
        const id = g.getAttribute('data-entity');
        const name = (g.getAttribute('data-portname') || '').trim();
        const key = name || id;
        const xy = (key && this._calibMap && this._calibMap[key]) ? this._calibMap[key] : null;
        const r = getPortRect(g);
        if (r && xy && Number.isFinite(Number(xy.x)) && Number.isFinite(Number(xy.y))) {
          const oldX = Number(r.getAttribute("x") || "0");
          const oldY = Number(r.getAttribute("y") || "0");
          const nx = Number(xy.x);
          const ny = Number(xy.y);
          r.setAttribute('x', String(nx));
          r.setAttribute('y', String(ny));
          const dx = nx - oldX;
          const dy = ny - oldY;
          if (Number.isFinite(dx) && Number.isFinite(dy) && (dx !== 0 || dy !== 0)) {
            const t = root.querySelector(`text.portlabel[data-entity="${CSS.escape(id)}"]`);
            if (t) {
              t.setAttribute("x", String(Number(t.getAttribute("x") || "0") + dx));
              t.setAttribute("y", String(Number(t.getAttribute("y") || "0") + dy));
            }
            const bg = root.querySelector(`rect.portlabel-bg[data-entity="${CSS.escape(id)}"]`);
            if (bg) {
              bg.setAttribute("x", String(Number(bg.getAttribute("x") || "0") + dx));
              bg.setAttribute("y", String(Number(bg.getAttribute("y") || "0") + dy));
            }
          }
        }
      });

      // Refresh overlays + computed layouts
      updatePortsBoxSvg();
      updateUplinkBoxSvg();
      if (this._calibPortsBoxMode) applyPortsBoxLayout();
      if (this._calibUplinkBoxMode) applyUplinkBoxLayout();
      refreshSelectionStyles();
      refreshSelCount();
      if (elSnap) elSnap.value = String(this._calibSnap || 0);
      if (elOrder) {
        try { elOrder.value = (this._calibPortsOrder === 'odd_even') ? 'odd_even' : 'numeric'; } catch (e) {}
      }
      if (elAdv?.style?.display !== 'none') refreshExport();
      this._calibDirty = true;
    };

    const beginUndo = () => {
      if (_calibHist.pending) return;
      _calibHist.pending = snapshotLayout();
    };

    const commitUndo = () => {
      if (!_calibHist.pending) return;
      const before = _calibHist.pending;
      _calibHist.pending = null;
      const after = snapshotLayout();
      if (before === after) return;

      _calibHist.undo.push(before);
      if (_calibHist.undo.length > MAX_HIST) _calibHist.undo.shift();
      _calibHist.redo.length = 0;
    };

    const doUndo = () => {
      const prev = _calibHist.undo.pop();
      if (!prev) return;
      _calibHist.redo.push(snapshotLayout());
      applySnapshot(prev);
    };

    const doRedo = () => {
      const next = _calibHist.redo.pop();
      if (!next) return;
      _calibHist.undo.push(snapshotLayout());
      applySnapshot(next);
    };

    // Ports box (main/physical ports) overlay
    const setPortsBoxVisible = (vis) => {
      if (portsLayer) portsLayer.style.pointerEvents = vis ? "all" : "none";
      if (portsRect) portsRect.style.display = vis ? "" : "none";
      portsHandles.forEach(h => { h.style.display = vis ? "" : "none"; });
    };

    const updatePortsBoxSvg = () => {
      const b = normBox(this._calibPortsBox);
      if (!portsRect) return;
      // Hide overlay when the tool is off (keep box data for later)
      if (!this._calibPortsBoxMode) {
        portsRect.style.display = "none";
        portsHandles.forEach(h => (h.style.display = "none"));
        return;
      }
      if (!b) {
        // If the tool is enabled but the box hasn't been drawn yet, keep the
        // elements hidden (no box yet), but do not change the tool mode.
        portsRect.style.display = "none";
        portsHandles.forEach(h => h.style.display = "none");
        return;
      }
      portsRect.style.display = "";
      portsRect.setAttribute("x", String(b.x));
      portsRect.setAttribute("y", String(b.y));
      portsRect.setAttribute("width", String(b.w));
      portsRect.setAttribute("height", String(b.h));

      const s = 10, hs = s/2;
      const pts = {
        nw: [b.x - hs, b.y - hs],
        n:  [b.x + b.w/2 - hs, b.y - hs],
        ne: [b.x + b.w - hs, b.y - hs],
        e:  [b.x + b.w - hs, b.y + b.h/2 - hs],
        se: [b.x + b.w - hs, b.y + b.h - hs],
        s:  [b.x + b.w/2 - hs, b.y + b.h - hs],
        sw: [b.x - hs, b.y + b.h - hs],
        w:  [b.x - hs, b.y + b.h/2 - hs],
      };
      portsHandles.forEach(el => {
        const k = el.getAttribute("data-h");
        const p = pts[k];
        if (!p) return;
        el.setAttribute("x", String(p[0]));
        el.setAttribute("y", String(p[1]));
      });

      // Ensure the box remains visible (with handles) whenever the tool is enabled.
      // This prevents the box from disappearing after drawing, so users can resize
      // it the same way as the Uplinks box.
      if (this._calibPortsBoxMode) {
        portsRect.style.display = "";
        portsHandles.forEach(h => (h.style.display = ""));
        if (portsLayer) portsLayer.style.pointerEvents = "all";
      }
    };

    const applyPortsBoxLayout = () => {
      const b = normBox(this._calibPortsBox);
      if (!b) return;

      // We place port SVG groups by translating their *top-left*.
      // To keep ports fully inside the box (and allow tighter packing),
      // we must account for the rendered port glyph width/height.
      // Use the first visible port element as our sizing reference.
      let portW = 0;
      let portH = 0;
      try {
        const sample = svg.querySelector(".port-svg");
        if (sample && typeof sample.getBBox === "function") {
          const bb = sample.getBBox();
          portW = Math.max(0, Number(bb?.width) || 0);
          portH = Math.max(0, Number(bb?.height) || 0);
        }
      } catch (e) {}
      // Fallbacks if getBBox() isn't available (should be rare)
      if (!portW) portW = 18;
      if (!portH) portH = 18;

      const separateUplinks = !!this._config?.show_uplinks_separately;
      const uplinkSet = new Set(((this._config?.uplink_ports || [])).map(s => String(s).trim().toLowerCase()).filter(Boolean));

      const gs = Array.from(svg.querySelectorAll(".port-svg[data-entity]"));
      const main = gs.map(g => ({
        g,
        id: g.getAttribute("data-entity"),
        name: (g.getAttribute("data-portname") || "")
      })).filter(p => p.id && (!separateUplinks || !uplinkSet.size || !uplinkSet.has(String(p.name||"").trim().toLowerCase())));
      if (!main.length) return;

      // If the user has explicitly positioned any main (non-uplink) ports, do not auto-pack them.
      const _posRaw = (this._isCalibrationEnabled() && this._calibMap && typeof this._calibMap === "object")
        ? this._calibMap
        : (this._config?.port_positions && typeof this._config.port_positions === "object" ? this._config.port_positions : null);
      if (_posRaw && typeof _posRaw === "object") {
        const _posKeys = new Set(Object.keys(_posRaw).map(k => String(k||"").trim().toLowerCase()).filter(Boolean));
        const _hasMainPos = main.some(p => _posKeys.has(String(p.name||"").trim().toLowerCase()));
        if (_hasMainPos) return;
      }

      // Order: numeric (default) or odd/even (2-row)
      const orderMode = (typeof this._calibPortsOrder === "string" && this._calibPortsOrder) ? this._calibPortsOrder : "numeric";

      const portNum = (name) => {
        const m = String(name || "").match(/(\d+)(?!.*\d)/);
        return m ? parseInt(m[1], 10) : NaN;
      };

      if (orderMode === "odd_even") {
        // Split into odd/even groups based on the last numeric component of the port name.
        const odds = [];
        const evens = [];
        main.forEach(p => {
          const n = portNum(p.name);
          if (Number.isFinite(n) && (n % 2 === 0)) evens.push({ ...p, _n: n });
          else odds.push({ ...p, _n: Number.isFinite(n) ? n : null });
        });

        const cmpNumThenNatural = (a,b) => {
          const an = a._n, bn = b._n;
          if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
          return _ssmNaturalPortCompare(a.name, b.name);
        };

        odds.sort(cmpNumThenNatural);
        evens.sort(cmpNumThenNatural);

        const w = Math.max(10, b.w);
        const h = Math.max(10, b.h);
        const cap = Math.max(1, parseInt(this._config?.ports_per_row, 10) || 24);

        const maxLen = Math.max(odds.length, evens.length);
        const cols = Math.max(1, Math.min(cap, maxLen || 1));

        const hasEvenRow = evens.length > 0;
        const rowGroupSize = hasEvenRow ? 2 : 1;
        const groups = Math.max(1, Math.ceil(maxLen / cols));
        const rows = groups * rowGroupSize;

        // Fit ports *within* the box: last port top-left cannot exceed (x + w - portW)
        const spanX = Math.max(0, w - portW);
        const spanY = Math.max(0, h - portH);
        const stepX = (cols > 1) ? (spanX / (cols - 1)) : 0;
        const stepY = (rows > 1) ? (spanY / (rows - 1)) : 0;

        const place = (arr, rowOffset) => {
          arr.forEach((p, i) => {
            const g = Math.floor(i / cols);
            const c = i % cols;
            const r = g * rowGroupSize + rowOffset;
            const x = Number(b.x) + stepX * c;
            const y = Number(b.y) + stepY * r;
            setPortXY(p.id, applySnap(x), applySnap(y));
          });
        };

        place(odds, 0);
        if (hasEvenRow) place(evens, 1);
      } else {
        // Default: natural numeric-ish order by port name
        main.sort((a,b)=>_ssmNaturalPortCompare(a.name,b.name));

        const n = main.length;
        const w = Math.max(10, b.w);
        const h = Math.max(10, b.h);
        const ratio = w / h;
        const cap = Math.max(1, parseInt(this._config?.ports_per_row, 10) || 24);
        const colsGuess = Math.max(1, Math.round(Math.sqrt(n * ratio)));
        const cols = Math.min(cap, colsGuess);
        const rows = Math.max(1, Math.ceil(n / cols));

        const spanX = Math.max(0, w - portW);
        const spanY = Math.max(0, h - portH);
        const stepX = (cols > 1) ? (spanX / (cols - 1)) : 0;
        const stepY = (rows > 1) ? (spanY / (rows - 1)) : 0;

        main.forEach((p, idx) => {
          const c = idx % cols;
          const r = Math.floor(idx / cols);
          const x = Number(b.x) + stepX * c;
          const y = Number(b.y) + stepY * r;
          setPortXY(p.id, applySnap(x), applySnap(y));
        });
      }
    };

    const setUplinkBoxVisible = (vis) => {
      if (uplLayer) uplLayer.style.pointerEvents = vis ? "all" : "none";
      if (uplRect) uplRect.style.display = vis ? "" : "none";
      uplHandles.forEach(h => { h.style.display = vis ? "" : "none"; });
    };

    const updateUplinkBoxSvg = () => {
      const b = normBox(this._calibUplinkBox);
      if (!uplRect) return;
      // Hide overlay when the tool is off (keep box data for later)
      if (!this._calibUplinkBoxMode) {
        uplRect.style.display = "none";
        uplHandles.forEach(h => (h.style.display = "none"));
        return;
      }
      if (!b) {
        uplRect.style.display = "none";
        uplHandles.forEach(h => h.style.display = "none");
        return;
      }
      uplRect.style.display = "";
      uplRect.setAttribute("x", String(b.x));
      uplRect.setAttribute("y", String(b.y));
      uplRect.setAttribute("width", String(b.w));
      uplRect.setAttribute("height", String(b.h));

      // Handles centered on corners/edges
      const s = 10, hs = s/2;
      const pts = {
        nw: [b.x - hs, b.y - hs],
        n:  [b.x + b.w/2 - hs, b.y - hs],
        ne: [b.x + b.w - hs, b.y - hs],
        e:  [b.x + b.w - hs, b.y + b.h/2 - hs],
        se: [b.x + b.w - hs, b.y + b.h - hs],
        s:  [b.x + b.w/2 - hs, b.y + b.h - hs],
        sw: [b.x - hs, b.y + b.h - hs],
        w:  [b.x - hs, b.y + b.h/2 - hs],
      };


      uplHandles.forEach(el => {
        const k = el.getAttribute("data-h");
        const p = pts[k];
        if (!p) return;
        el.setAttribute("x", String(p[0]));
        el.setAttribute("y", String(p[1]));
      });
    };

// Keep the Uplinks box enclosing all uplink ports (without restricting dragging).
const fitUplinkBoxToPorts = () => {
  try {
    const separateUplinks = !!this._config?.show_uplinks_separately;
    const uplinkSet = new Set(((this._config?.uplink_ports || [])).map(s => String(s).trim().toLowerCase()).filter(Boolean));
    if (!separateUplinks || !uplinkSet.size) return;
    if (!this._calibUplinkBoxMode) return;

    const gs = Array.from(svg.querySelectorAll(".port-svg[data-entity]"));
    const upl = gs
      .map(g => ({ g, id: g.getAttribute("data-entity"), name: (g.getAttribute("data-portname") || "") }))
      .filter(p => p.id && uplinkSet.has(String(p.name || "").trim().toLowerCase()));
    if (!upl.length) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let pw = null, ph = null;

    upl.forEach(p => {
      const r = p.g.querySelector("rect");
      if (!r) return;
      const x = parseFloat(r.getAttribute("x"));
      const y = parseFloat(r.getAttribute("y"));
      const w = parseFloat(r.getAttribute("width"));
      const h = parseFloat(r.getAttribute("height"));
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return;
      pw = (pw == null) ? w : pw;
      ph = (ph == null) ? h : ph;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    });

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return;

    const pad = 0;
    const nx = Math.max(0, minX - pad);
    const ny = Math.max(0, minY - pad);
    const minW = (pw != null && Number.isFinite(pw)) ? pw : 1;
    const minH = (ph != null && Number.isFinite(ph)) ? ph : 1;
    const nw = Math.max(minW, (maxX - minX) + (pad * 2));
    const nh = Math.max(minH, (maxY - minY) + (pad * 2));
    this._calibUplinkBox = { x: nx, y: ny, w: nw, h: nh };
    updateUplinkBoxSvg();
    this._calibDirty = true;
  } catch (e) {}
};

// Keep the Ports box enclosing all NON-uplink ports (without restricting dragging).
const fitPortsBoxToPorts = () => {
  try {
    if (!this._calibPortsBoxMode) return;
    const uplinkSet = new Set(((this._config?.uplink_ports || [])).map(s => String(s).trim().toLowerCase()).filter(Boolean));

    const gs = Array.from(svg.querySelectorAll(".port-svg[data-entity]"));
    const main = gs
      .map(g => ({ g, id: g.getAttribute("data-entity"), name: (g.getAttribute("data-portname") || "") }))
      .filter(p => p.id && !uplinkSet.has(String(p.name || "").trim().toLowerCase()));
    if (!main.length) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let pw = null, ph = null;

    main.forEach(p => {
      const r = p.g.querySelector("rect");
      if (!r) return;
      const x = parseFloat(r.getAttribute("x"));
      const y = parseFloat(r.getAttribute("y"));
      const w = parseFloat(r.getAttribute("width"));
      const h = parseFloat(r.getAttribute("height"));
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return;
      pw = (pw == null) ? w : pw;
      ph = (ph == null) ? h : ph;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    });

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return;

    const pad = 0;
    const nx = Math.max(0, minX - pad);
    const ny = Math.max(0, minY - pad);
    const nw = Math.max(40, (maxX - minX) + (pad * 2));
    const nh = Math.max(40, (maxY - minY) + (pad * 2));
    this._calibPortsBox = { x: nx, y: ny, w: nw, h: nh };
    updatePortsBoxSvg();
    this._calibDirty = true;
  } catch (e) {}
};

    const applyUplinkBoxLayout = () => {
      const b = normBox(this._calibUplinkBox);
      if (!b) return;
      const separateUplinks = !!this._config?.show_uplinks_separately;
      const uplinkSet = new Set(((this._config?.uplink_ports || [])).map(s => String(s).trim().toLowerCase()).filter(Boolean));
      if (!separateUplinks || !uplinkSet.size) return;

      const gs = Array.from(svg.querySelectorAll(".port-svg[data-entity]"));
      const upl = gs.map(g => ({ g, id: g.getAttribute("data-entity"), name: (g.getAttribute("data-portname")||"") }))
        .filter(p => p.id && uplinkSet.has(String(p.name||"").trim().toLowerCase()));
      if (!upl.length) return;

      // If the user has explicitly positioned any uplink ports, do not auto-pack them.
      const _posRaw = (this._isCalibrationEnabled() && this._calibMap && typeof this._calibMap === "object")
        ? this._calibMap
        : (this._config?.port_positions && typeof this._config.port_positions === "object" ? this._config.port_positions : null);
      if (_posRaw && typeof _posRaw === "object") {
        const _posKeys = new Set(Object.keys(_posRaw).map(k => String(k||"").trim().toLowerCase()).filter(Boolean));
        const _hasUplinkPos = upl.some(p => _posKeys.has(String(p.name||"").trim().toLowerCase()));
        if (_hasUplinkPos) return;
      }

      const n = upl.length;
      const w = Math.max(10, Number(b.w) || 0);
      const h = Math.max(10, Number(b.h) || 0);

      // Account for port size so ports stay INSIDE the box.
      const firstRect = root.querySelector(".port-svg rect");
      const portW = (firstRect && Number.isFinite(parseFloat(firstRect.getAttribute("width"))))
        ? parseFloat(firstRect.getAttribute("width"))
        : Number(this._config?.port_size || 18);
      const portH = (firstRect && Number.isFinite(parseFloat(firstRect.getAttribute("height"))))
        ? parseFloat(firstRect.getAttribute("height"))
        : portW;

      const spanX = Math.max(0, w - portW);
      const spanY = Math.max(0, h - portH);
      const ratio = (spanY > 0) ? (spanX / spanY) : (spanX || 1);

      const cols = Math.max(1, Math.round(Math.sqrt(n * ratio)));
      const rows = Math.max(1, Math.ceil(n / cols));
      const stepX = (cols > 1) ? (spanX / (cols - 1)) : 0;
      const stepY = (rows > 1) ? (spanY / (rows - 1)) : 0;

      const baseX = Number(b.x) || 0;
      const baseY = Number(b.y) || 0;

      upl.forEach((p, idx) => {
        const c = idx % cols;
        const r = Math.floor(idx / cols);
        const x = baseX + stepX * c;
        const y = baseY + stepY * r;
        setPortXY(p.id, applySnap(x), applySnap(y));
      });
    };

    // Ports Box toggle (for main ports)
    if (portsBtn && !portsBtn._ssmBound) {
      portsBtn._ssmBound = true;
      portsBtn.addEventListener("click", () => {
        // Only one box tool active at a time
        this._calibPortsBoxMode = !this._calibPortsBoxMode;
        if (this._calibPortsBoxMode) {
          this._calibUplinkBoxMode = false;
          if (uplBtn) uplBtn.classList.remove("active");
          setUplinkBoxVisible(false);
        }

        portsBtn.classList.toggle("active", !!this._calibPortsBoxMode);
        setMsg(this._calibPortsBoxMode ? "Ports box: drag to draw, drag handles to resize" : "");
        setPortsBoxVisible(!!this._calibPortsBoxMode);
        // Order only applies to Ports box layout; show it only when Ports tool is active
        const orderWrap = root.getElementById("ssm-calib-order-wrap");
        if (orderWrap) orderWrap.style.display = this._calibPortsBoxMode ? "" : "none";

        // Create a default box if enabling and none exists (then fit to current non-uplink ports)
        if (this._calibPortsBoxMode && !normBox(this._calibPortsBox)) {
          this._calibPortsBox = { x: 20, y: 20, w: 240, h: 160 };
        }
        if (this._calibPortsBoxMode) {
          fitPortsBoxToPorts();
        }

        

        updatePortsBoxSvg();
        applyPortsBoxLayout();
        this._calibDirty = true;
        refreshExport();
      });
    }

    // Ports ordering for Ports box layout
    if (elOrder) {
      // Order only applies to Ports tool
      const _orderWrap = root.getElementById("ssm-calib-order-wrap");
      if (_orderWrap) _orderWrap.style.display = this._calibPortsBoxMode ? "" : "none";
      try { elOrder.value = this._calibPortsOrder || "numeric"; } catch (e) {}
      if (!elOrder._ssmBound) {
        elOrder._ssmBound = true;
        elOrder.addEventListener("change", () => {
          this._calibPortsOrder = (elOrder.value || "numeric");
          this._calibDirty = true;
          // When using the Ports box tool, changing order should immediately re-layout.
          if (this._calibPortsBoxMode) {
            try { applyPortsBoxLayout(); } catch (e) {}
          }
          refreshExport();
        });
      }
    }


    // Uplinks Box toggle
    if (uplBtn && !uplBtn._ssmBound) {
      uplBtn._ssmBound = true;
      uplBtn.addEventListener("click", () => {
        // Only one box tool active at a time
        if (!this._calibUplinkBoxMode) {
          this._calibPortsBoxMode = false;
          if (portsBtn) portsBtn.classList.remove("active");
          setPortsBoxVisible(false);
        }
        this._calibUplinkBoxMode = !this._calibUplinkBoxMode;
        uplBtn.classList.toggle("active", !!this._calibUplinkBoxMode);
        setMsg(this._calibUplinkBoxMode ? "Uplinks box: drag to draw, drag handles to resize" : "");
        setUplinkBoxVisible(!!this._calibUplinkBoxMode);

        // Create a default box if enabling and none exists (then fit to current uplink ports)
        if (this._calibUplinkBoxMode && !normBox(this._calibUplinkBox)) {
          this._calibUplinkBox = { x: 20, y: 20, w: 200, h: 140 };
          // Do NOT persist layout editor changes until the user explicitly clicks Save.
        }
        if (this._calibUplinkBoxMode) {
          // Match Ports box behavior: when enabling the tool, tighten the Uplinks box
          // around existing uplink port positions with no padding.
          try { fitUplinkBoxToPorts(); } catch (e) {}
        }

        
        updateUplinkBoxSvg();
        applyUplinkBoxLayout();
        this._calibDirty = true;
        refreshExport();
      });
    }

    // Default: box overlays should NOT be visible unless their tool is enabled.
    setPortsBoxVisible(!!this._calibPortsBoxMode);
    if (this._calibPortsBoxMode) updatePortsBoxSvg();
    setUplinkBoxVisible(!!this._calibUplinkBoxMode);
    if (this._calibUplinkBoxMode) updateUplinkBoxSvg();

    // Snap select

    if (elSnap && !elSnap._ssmBound) {
      elSnap._ssmBound = true;
      elSnap.value = String(this._calibSnap || 0);
      const onSnap = () => {
        this._calibSnap = parseInt(elSnap.value, 10) || 0;
      };
      elSnap.addEventListener("input", onSnap);
      elSnap.addEventListener("change", onSnap);
}

    // Advanced toggle
    if (elAdvToggle && !elAdvToggle._ssmBound) {
      elAdvToggle._ssmBound = true;
      elAdvToggle.addEventListener("click", () => {
        const show = (elAdv?.style?.display === "none");
        if (elAdv) elAdv.style.display = show ? "block" : "none";
        if (show) refreshExport();
      });
    }

    // Copy JSON
    root.getElementById("ssm-calib-copy-json")?.addEventListener("click", () => {
      const txt = elJson?.value || "";
      if (txt) this._copyToClipboard(txt);
    });
    // Apply / Format / Clear JSON (Advanced)
    const elJsonErr = root.getElementById("ssm-calib-json-error");
    const showJsonErr = (msg) => {
      if (!elJsonErr) return;
      if (msg) {
        elJsonErr.textContent = msg;
        elJsonErr.style.display = "block";
      } else {
        elJsonErr.textContent = "";
        elJsonErr.style.display = "none";
      }
    };

    root.getElementById("ssm-calib-apply-json")?.addEventListener("click", () => {
      try {
        showJsonErr("");
        const raw = (elJson?.value || "").trim();
        const obj = raw ? JSON.parse(raw) : {};
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
          throw new Error("JSON must be an object mapping port names to {x,y}.");
        }

        // Build lookup for current SVG ports so we can apply by either Port Name or entity_id.
        const portEls = Array.from(root.querySelectorAll(".port-svg[data-entity]"));
        const byPortName = new Map();
        const byEntity = new Map();
        portEls.forEach((g) => {
          const ent = String(g.getAttribute("data-entity") || "").trim();
          const pn = String(g.getAttribute("data-portname") || "").trim();
          if (ent) byEntity.set(ent.toLowerCase(), ent);
          if (pn) byPortName.set(pn.toLowerCase(), ent);
        });

        // Normalize + validate, then apply directly to current SVG (no full re-render needed).
        const next = {};
        for (const [k, v] of Object.entries(obj)) {
          const key = String(k || "").trim();
          if (!key) continue;
          if (!v || typeof v !== "object") continue;
          const x = Number(v.x);
          const y = Number(v.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

          const ent =
            byPortName.get(key.toLowerCase()) ||
            byEntity.get(key.toLowerCase()) ||
            null;

          if (!ent) continue;

          const g = root.querySelector(`.port-svg[data-entity="${CSS.escape(ent)}"]`);
          const pn = String(g?.getAttribute("data-portname") || "").trim() || key;
          next[pn] = { x, y };

          const r = g?.querySelector("rect");
          if (r) {
            r.setAttribute("x", String(x));
            r.setAttribute("y", String(y));
          }
        }

        this._calibMap = next;
        this._calibDirty = true;

        // Re-render once (temporarily bypassing freeze) so labels + overlays recompute correctly.
        const prevFreeze = this._freezeRenderWhileCalibrationActive;
        this._freezeRenderWhileCalibrationActive = false;
        this._render();
        this._freezeRenderWhileCalibrationActive = prevFreeze;

        refreshExport();
      } catch (e) {
        showJsonErr(String(e?.message || e));
      }
    });
    root.getElementById("ssm-calib-format-json")?.addEventListener("click", () => {
      try {
        showJsonErr("");
        const raw = (elJson?.value || "").trim();
        const obj = raw ? JSON.parse(raw) : {};
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("JSON must be an object mapping port names to {x,y}.");
        if (elJson) elJson.value = JSON.stringify(obj, null, 2);
      } catch (e) {
        showJsonErr(String(e?.message || e));
      }
    });

    root.getElementById("ssm-calib-clear-json")?.addEventListener("click", () => {
      showJsonErr("");
      // Reset positions immediately WITHOUT closing the Advanced JSON editor.
      // We clear the in-memory overrides, then re-apply the default grid layout
      // to the current SVG and regenerate the JSON from those new positions.
      this._calibMap = {};

      try {
        const gs = Array.from(root.querySelectorAll(".port-svg[data-entity]"));
        const firstRect = gs[0]?.querySelector("rect");
        const P = (firstRect && Number.isFinite(parseFloat(firstRect.getAttribute("width"))))
          ? parseFloat(firstRect.getAttribute("width"))
          : Number(this._config?.port_size || 28);
        const Gh = Number(this._config?.horizontal_port_gap);
        const Gv = Number(this._config?.vertical_port_gap);
        const perRow = Math.max(1, parseInt(this._config?.ports_per_row, 10) || 24);
        const W = Number((this._config?.panel_width ?? 1440));
        const sidePad = 28;
        const topPad = 24;
        const usableW = W - 2 * sidePad;
        const totalRowW = perRow * P + Math.max(0, (perRow - 1)) * (Number.isFinite(Gh) ? Gh : 0);
        const startX = sidePad + Math.max(0, (usableW - totalRowW) / 2);

        // Apply to each visible port in DOM order (matches the rendered order).
        let i = 0;
        gs.forEach((g) => {
          const id = String(g.getAttribute("data-entity") || "").trim();
          if (!id) return;
          const col = i % perRow;
          const row = Math.floor(i / perRow);
          const x = startX + col * (P + (Number.isFinite(Gh) ? Gh : 0));
          const y = topPad + row * (P + (Number.isFinite(Gv) ? Gv : 0)) + 18;
          setPortXY(id, applySnap(x), applySnap(y));
          i++;
        });

        // Also clear selection when doing a full reset.
        this._calibSel?.clear?.();
        refreshSelectionStyles();
        refreshSelCount();

        this._calibDirty = true;
      } catch (e) {
        // Fall back to a simple clear if something unexpected happens.
        this._calibMap = {};
      }

      refreshExport();
    });


    // Save / Reset
    root.getElementById("ssm-calib-save")?.addEventListener("click", () => {
      // Persist locally for immediate UX, and also emit an event so the editor can
      // write the positions back into the card config (so it survives reloads).
      this._persistCalibMapToStorage();
      try {
        this.dispatchEvent(new CustomEvent("ssm-port-positions-saved", {
          detail: {
            device: this._config?.device || "",
            background_image: this._config?.background_image || "",
            port_positions: (this._calibMap && typeof this._calibMap === "object") ? this._calibMap : {},
          },
          bubbles: true,
          composed: true,
        }));
      } catch (e) {}
      this._calibDirty = false;
      setMsg("Saved");
      setTimeout(() => setMsg(""), 1200);
    });

    // Undo / Redo (in-memory only while the Layout Editor is open)
    root.getElementById("ssm-calib-undo")?.addEventListener("click", () => doUndo());
    root.getElementById("ssm-calib-redo")?.addEventListener("click", () => doRedo());

    root.getElementById("ssm-calib-reset")?.addEventListener("click", () => {
      beginUndo();
      this._calibMap = {};
      this._calibSel = new Set();
      refreshSelCount();
      refreshSelectionStyles();
      clearMarquee();
      refreshExport();
      // snap ports back by forcing a re-render next tick
      this._freezeRenderWhileCalibrationActive = false;
      this._render();
      this._calibDirty = true;
      commitUndo();
    });

    root.getElementById("ssm-calib-close")?.addEventListener("click", () => {
      // Exit Layout Editor immediately.
      this._freezeRenderWhileCalibrationActive = false;
      // Persist a "force off" flag so the card editor toggle resets even if the editor is not open.
      try {
        const prefix = (this._config?.device || "") ? String(this._config.device) : "all";
        localStorage.setItem(`ssm_calib_force_off:${prefix}`, String(Date.now()));
      } catch (e) {}
      this._calibUiClosed = false;

      // Ask the editor (if open) to turn the toggle off so it persists when you save.
      try {
        window.dispatchEvent(new CustomEvent("ssm-calibration-closed", {
          detail: { device: this._config?.device || "" }
        }));
      } catch (e) {}

      // Also emit a standard Lovelace editor event as a fallback (works when the card is shown in preview).
      try {
        const newCfg = { ...(this._config || {}), calibration_mode: false };
        this._config = newCfg;
        this.dispatchEvent(new CustomEvent("config-changed", {
          detail: { config: newCfg },
          bubbles: true,
          composed: true,
        }));
      } catch (e) {
        this._config = { ...(this._config || {}), calibration_mode: false };
      }

      this._render();
    });

    // Align / distribute helpers
    const getSelectedGs = () => {
      const sel = this._calibSel || new Set();
      const gs = [];
      sel.forEach(id => {
        const g = root.querySelector(`.port-svg[data-entity="${CSS.escape(id)}"]`);
        if (g) gs.push(g);
      });
      return gs;
    };

    const alignRow = () => {
      const gs = getSelectedGs();
      if (gs.length < 2) return;
      const ref = getGXY(gs[0]);
      if (!ref) return;
      const y = ref.y;
      gs.forEach(g => {
        const id = g.getAttribute("data-entity");
        const xy = getGXY(g);
        if (!id || !xy) return;
        setPortXY(id, xy.x, y);
      });
      this._calibDirty = true;
      if (elAdv?.style?.display !== "none") refreshExport();
    };

    const alignCol = () => {
      const gs = getSelectedGs();
      if (gs.length < 2) return;
      const ref = getGXY(gs[0]);
      if (!ref) return;
      const x = ref.x;
      gs.forEach(g => {
        const id = g.getAttribute("data-entity");
        const xy = getGXY(g);
        if (!id || !xy) return;
        setPortXY(id, x, xy.y);
      });
      this._calibDirty = true;
      if (elAdv?.style?.display !== "none") refreshExport();
    };

    const distribute = (axis) => {
      const gs = getSelectedGs();
      if (gs.length < 2) return;

      const pts = gs
        .map(g => ({ g, id: g.getAttribute("data-entity"), xy: getGXY(g) }))
        .filter(o => o.id && o.xy);

      if (pts.length < 2) return;

      // With only 2 points, "distribute" is still useful: place the 2nd item at a sane default spacing
      // (port size + gap) from the 1st item so it visibly does something for 2-row switches.
      if (pts.length === 2) {
        pts.sort((a,b)=> axis==="x" ? a.xy.x-b.xy.x : a.xy.y-b.xy.y);
        const r0 = getPortRect(pts[0].g);
        const size = r0 ? parseFloat(r0.getAttribute("width")) : NaN;
        const gap = Number(this._config?.port_gap ?? 0);
        const defaultStep = (Number.isFinite(size) ? size : 0) + (Number.isFinite(gap) ? gap : 0);

        const v0 = pts[0].xy[axis];
        const v1 = Number.isFinite(defaultStep) && defaultStep > 0 ? (v0 + defaultStep) : pts[1].xy[axis];

        if (axis === "x") setPortXY(pts[1].id, v1, pts[1].xy.y);
        else setPortXY(pts[1].id, pts[1].xy.x, v1);

        this._calibDirty = true;
        if (elAdv?.style?.display !== "none") refreshExport();
        return;
      }

      pts.sort((a,b)=> axis==="x" ? a.xy.x-b.xy.x : a.xy.y-b.xy.y);
      const first = pts[0].xy[axis], last = pts[pts.length-1].xy[axis];
      const step = (last - first) / (pts.length - 1);
      pts.forEach((p, i) => {
        const v = first + step * i;
        if (axis === "x") setPortXY(p.id, v, p.xy.y);
        else setPortXY(p.id, p.xy.x, v);
      });
      this._calibDirty = true;
      if (elAdv?.style?.display !== "none") refreshExport();
    };

    root.getElementById("ssm-calib-align-row")?.addEventListener("click", alignRow);
    root.getElementById("ssm-calib-align-col")?.addEventListener("click", alignCol);
    root.getElementById("ssm-calib-dist-h")?.addEventListener("click", () => distribute("x"));
    root.getElementById("ssm-calib-dist-v")?.addEventListener("click", () => distribute("y"));
    // Cursor coordinates + box clicks + marquee select
    const hit = root.getElementById("ssm-calib-hit");
    if (hit && !hit._ssmBound) {
      hit._ssmBound = true;

      let boxSelecting = false;
      let boxPid = null;
      let boxStart = null;

	      // Auto layout drag-box state
	      let saDragging = false;
	      let saPid = null;
	      let saStart = null;

      // Uplinks Box interaction state
      let ubActive = false;
      let ubPid = null;
      let ubKind = null; // "draw" | "move" | "resize"
      let ubHandle = null; // handle key
      let ubStart = null; // pointer start pt
      let ubOrig = null;  // original box

      // Ports Box interaction state
      let pbActive = false;
      let pbPid = null;
      let pbKind = null; // "draw" | "move" | "resize"
      let pbHandle = null;
      let pbStart = null;
      let pbOrig = null
      let pbMoveStartPositions = null; // Map entity_id -> {x,y} for moving ports box
      let pbResizeStartPositions = null; // Map entity_id -> {x,y} for resizing ports box
      let ubMoveStartPositions = null; // Map entity_id -> {x,y} for moving uplinks box
      let ubResizeStartPositions = null; // Map entity_id -> {x,y} for resizing uplinks box
;
	const onMove = (ev) => {
        const pt = this._svgPoint(svg, ev.clientX, ev.clientY);
        if (elXY) elXY.textContent = `${Math.round(pt.x)}, ${Math.round(pt.y)}`;

	        if (saDragging && saPid === ev.pointerId && saStart) {
	          ev.preventDefault();
	          const x1 = saStart.x, y1 = saStart.y;
	          const x2 = pt.x, y2 = pt.y;
	          const rx = Math.min(x1, x2);
	          const ry = Math.min(y1, y2);
	          const rw = Math.abs(x2 - x1);
	          const rh = Math.abs(y2 - y1);
	          if (marquee) {
	            marquee.style.display = "block";
	            marquee.setAttribute("x", String(rx));
	            marquee.setAttribute("y", String(ry));
	            marquee.setAttribute("width", String(rw));
	            marquee.setAttribute("height", String(rh));
	          }
	          return;
	        }

        if (pbActive && pbPid === ev.pointerId && pbStart) {
          ev.preventDefault();
          const b0 = pbOrig || normBox(this._calibPortsBox) || { x: pt.x, y: pt.y, w: 240, h: 160 };
          const dx = pt.x - pbStart.x;
          const dy = pt.y - pbStart.y;

          let nb = { ...b0 };
          // Allow tight packing: keep minimums near the glyph size instead of large fixed values.
          // This lets users shrink the box to reduce inter-port spacing.
          let minW = 10, minH = 10;
          try {
            const sample = svg.querySelector('.port-svg');
            if (sample && typeof sample.getBBox === 'function') {
              const bb = sample.getBBox();
              minW = Math.max(minW, (Number(bb?.width) || 0));
              minH = Math.max(minH, (Number(bb?.height) || 0));
            }
          } catch (e) {}

          if (pbKind === "draw") {
            const x1 = pbStart.x, y1 = pbStart.y;
            const x2 = pt.x, y2 = pt.y;
            nb.x = Math.min(x1, x2);
            nb.y = Math.min(y1, y2);
            nb.w = Math.max(minW, Math.abs(x2 - x1));
            nb.h = Math.max(minH, Math.abs(y2 - y1));
          } else if (pbKind === "move") {
            nb.x = b0.x + dx;
            nb.y = b0.y + dy;
            // Move physical ports along with the box (container behavior).
            if (pbMoveStartPositions && pbMoveStartPositions.size) {
              pbMoveStartPositions.forEach((pos, id) => {
                setPortXY(id, applySnap(pos.x + dx), applySnap(pos.y + dy));
              });
            }
          } else if (pbKind === "resize") {
            const h = String(pbHandle || "");
            if (h.includes("e")) nb.w = Math.max(minW, b0.w + dx);
            if (h.includes("s")) nb.h = Math.max(minH, b0.h + dy);
            if (h.includes("w")) {
              const nw = Math.max(minW, b0.w - dx);
              nb.x = b0.x + (b0.w - nw);
              nb.w = nw;
            }
            if (h.includes("n")) {
              const nh = Math.max(minH, b0.h - dy);
              nb.y = b0.y + (b0.h - nh);
              nb.h = nh;
            }
          }

          
          // When resizing, treat the box as a container: scale main (non-uplink) ports to stay inside.
          if (pbKind === "resize" && pbResizeStartPositions && pbResizeStartPositions.size) {
            const ow = Math.max(1e-6, Number(b0.w) || 0);
            const oh = Math.max(1e-6, Number(b0.h) || 0);
            const nx = Number(nb.x) || 0;
            const ny = Number(nb.y) || 0;
            const nw = Math.max(1e-6, Number(nb.w) || 0);
            const nh = Math.max(1e-6, Number(nb.h) || 0);

            const clamp01 = (v) => (v < 0 ? 0 : (v > 1 ? 1 : v));

            pbResizeStartPositions.forEach((pos, id) => {
              if (!pos || !id) return;
              const rx = clamp01((Number(pos.x) - Number(b0.x)) / ow);
              const ry = clamp01((Number(pos.y) - Number(b0.y)) / oh);
              const x = nx + rx * nw;
              const y = ny + ry * nh;
              setPortXY(id, applySnap(x), applySnap(y));
            });
          }

this._calibPortsBox = nb;
          updatePortsBoxSvg();
          if (pbKind === "draw") applyPortsBoxLayout();
          this._calibDirty = true;
          return;
        }

        if (ubActive && ubPid === ev.pointerId && ubStart) {
          ev.preventDefault();
          const b0 = ubOrig || normBox(this._calibUplinkBox) || { x: pt.x, y: pt.y, w: 120, h: 90 };
          const dx = pt.x - ubStart.x;
          const dy = pt.y - ubStart.y;

          let nb = { ...b0 };

          const minW = 40, minH = 30;

          if (ubKind === "draw") {
            const x1 = ubStart.x, y1 = ubStart.y;
            const x2 = pt.x, y2 = pt.y;
            nb.x = Math.min(x1, x2);
            nb.y = Math.min(y1, y2);
            nb.w = Math.max(minW, Math.abs(x2 - x1));
            nb.h = Math.max(minH, Math.abs(y2 - y1));
          } else if (ubKind === "move") {
            nb.x = b0.x + dx;
            nb.y = b0.y + dy;
            // Move uplink ports along with the box (container behavior).
            if (ubMoveStartPositions && ubMoveStartPositions.size) {
              ubMoveStartPositions.forEach((pos, id) => {
                setPortXY(id, applySnap(pos.x + dx), applySnap(pos.y + dy));
              });
            }
          } else if (ubKind === "resize") {
            const h = String(ubHandle || "");
            // edge/corner logic
            if (h.includes("e")) nb.w = Math.max(minW, b0.w + dx);
            if (h.includes("s")) nb.h = Math.max(minH, b0.h + dy);
            if (h.includes("w")) { 
              const nw = Math.max(minW, b0.w - dx);
              nb.x = b0.x + (b0.w - nw);
              nb.w = nw;
            }
            if (h.includes("n")) {
              const nh = Math.max(minH, b0.h - dy);
              nb.y = b0.y + (b0.h - nh);
              nb.h = nh;
            }
          }

          
          // When resizing, treat the box as a container: scale uplink ports to stay inside.
          if (ubKind === "resize" && ubResizeStartPositions && ubResizeStartPositions.size) {
            const ow = Math.max(1e-6, Number(b0.w) || 0);
            const oh = Math.max(1e-6, Number(b0.h) || 0);
            const nx = Number(nb.x) || 0;
            const ny = Number(nb.y) || 0;
            const nw = Math.max(1e-6, Number(nb.w) || 0);
            const nh = Math.max(1e-6, Number(nb.h) || 0);

            const clamp01 = (v) => (v < 0 ? 0 : (v > 1 ? 1 : v));

            ubResizeStartPositions.forEach((pos, id) => {
              if (!pos || !id) return;
              const rx = clamp01((Number(pos.x) - Number(b0.x)) / ow);
              const ry = clamp01((Number(pos.y) - Number(b0.y)) / oh);
              const x = nx + rx * nw;
              const y = ny + ry * nh;
              setPortXY(id, applySnap(x), applySnap(y));
            });
          }

this._calibUplinkBox = nb;
          updateUplinkBoxSvg();
                    this._calibDirty = true;
          return;
        }

        if (boxSelecting && boxPid === ev.pointerId && boxStart) {
          ev.preventDefault();
          const x1 = boxStart.x, y1 = boxStart.y;
          const x2 = pt.x, y2 = pt.y;
          const rx = Math.min(x1, x2);
          const ry = Math.min(y1, y2);
          const rw = Math.abs(x2 - x1);
          const rh = Math.abs(y2 - y1);
          if (marquee) {
            marquee.style.display = "block";
            marquee.setAttribute("x", String(rx));
            marquee.setAttribute("y", String(ry));
            marquee.setAttribute("width", String(rw));
            marquee.setAttribute("height", String(rh));
          }
        }
      };

	      const onUp = (ev) => {
        const isPb = (pbPid === ev.pointerId);
        const isUb = (ubPid === ev.pointerId);
        const isBox = (boxPid === ev.pointerId);
	        const isSa = (saPid === ev.pointerId);

	        if (!isPb && !isUb && !isBox && !isSa) return;
	        try { hit.releasePointerCapture(ev.pointerId); } catch (e) {}
	        const pt = this._svgPoint(svg, ev.clientX, ev.clientY);
	        if (isSa && saDragging && saStart) {
	          // Commit box
	          saDragging = false;
	          saPid = null;
	          const pt2 = pt;
	          const pt1 = saStart;
	          saStart = null;
	          clearMarquee();
	          this._calibAssist = null;
	          this._calibAssistPt1 = null;
	          setMsg("Applying…");
	
	          const applyAutoLayout = (pt1, pt2) => {
	            // Build odd/top even/bottom two-row layout from currently rendered ports
	            const gs = Array.from(root.querySelectorAll(".port-svg[data-entity]"));
	            const ports = gs.map(g => {
	              const id = g.getAttribute("data-entity");
	              const name = g.getAttribute("data-portname") || "";
	              const m = name.match(/(\d+)(?!.*\d)/);
	              const n = m ? parseInt(m[1], 10) : NaN;
	              return { id, name, n };
	            }).filter(p => p.id);

	            const uplinkSet = new Set(((this._config?.uplink_ports || [])).map(s => String(s).trim().toLowerCase()).filter(Boolean));
	            const separateUplinks = !!this._config?.show_uplinks_separately;
	            const uplinks = (separateUplinks && uplinkSet.size) ? ports.filter(p => uplinkSet.has(String(p.name||"").trim().toLowerCase())) : [];
	            const mainPorts = (separateUplinks && uplinks.length) ? ports.filter(p => !uplinkSet.has(String(p.name||"").trim().toLowerCase())) : ports;

	            const odds = mainPorts.filter(p => Number.isFinite(p.n) && (p.n % 2 === 1)).sort((a,b)=>a.n-b.n);
	            const evens = mainPorts.filter(p => Number.isFinite(p.n) && (p.n % 2 === 0)).sort((a,b)=>a.n-b.n);
	            const useTwoRow = odds.length && evens.length;

	            const count = mainPorts.length;
	            const cols = Math.max(1, Math.ceil(count / 2));
	            const xMin = Math.min(pt1.x, pt2.x);
	            const xMax = Math.max(pt1.x, pt2.x);
	            const yTop = Math.min(pt1.y, pt2.y);
	            const yBot = Math.max(pt1.y, pt2.y);

	            // Auto layout should create a visible, resizable Ports box from the drag bounds
	            // (same UX concept as the Uplinks box). This is editor-only state and is NOT
	            // persisted until the user explicitly clicks Save.
	            try {
	              this._calibPortsBox = {
	                x: xMin,
	                y: yTop,
	                w: Math.max(80, xMax - xMin),
	                h: Math.max(60, yBot - yTop),
	              };
	              this._calibPortsBoxMode = true;
	              if (portsBtn) portsBtn.classList.add("active");
	              setPortsBoxVisible(true);
	              updatePortsBoxSvg();
	            } catch (e) {}
	            const step = (cols > 1) ? (xMax - xMin) / (cols - 1) : 0;
	
	            const placeSeq = (arr, y) => {
	              arr.forEach((p, i) => {
	                const x = xMin + step * i;
	                setPortXY(p.id, applySnap(x), applySnap(y));
	              });
	            };

	            if (useTwoRow) {
	              placeSeq(odds, yTop);
	              placeSeq(evens, yBot);
	            } else {
	              const top = mainPorts.slice(0, cols);
	              const bot = mainPorts.slice(cols);
	              placeSeq(top, yTop);
	              placeSeq(bot, yBot);
	            }

	            // Place uplinks into Uplinks Box (grid)
	            if (uplinks && uplinks.length) {
	              const ensureBox = () => {
	                if (this._calibUplinkBox && typeof this._calibUplinkBox === "object" && this._calibUplinkBox.w > 0 && this._calibUplinkBox.h > 0) {
	                  return this._calibUplinkBox;
	                }
	                const pad = 16;
	                const boxW = Math.max(120, Math.min(260, (xMax - xMin) * 0.45 || 200));
	                const boxH = Math.max(90, Math.min(220, (yBot - yTop) || 160));
	                const bx = xMax + pad;
	                const by = yTop;
	                this._calibUplinkBox = { x: bx, y: by, w: boxW, h: boxH };
	                return this._calibUplinkBox;
	              };
	
	              const box = ensureBox();
	              // Make the Uplinks box visible/resizable after auto layout (editor-only state;
	              // persisted only when the user clicks Save).
	              try {
	                this._calibUplinkBoxMode = true;
	                if (uplBtn) uplBtn.classList.add("active");
	                setUplinkBoxVisible(true);
	                updateUplinkBoxSvg();
	              } catch (e) {}
	              const placeInBox = (arr, b) => {
                const n = arr.length;
                if (!n) return;
                const w = Math.max(10, Number(b.w) || 0);
                const h = Math.max(10, Number(b.h) || 0);

                // Account for port size so ports stay INSIDE the box.
                const firstRect = root.querySelector(".port-svg rect");
                const portW = (firstRect && Number.isFinite(parseFloat(firstRect.getAttribute("width"))))
                  ? parseFloat(firstRect.getAttribute("width"))
                  : Number(this._config?.port_size || 18);
                const portH = (firstRect && Number.isFinite(parseFloat(firstRect.getAttribute("height"))))
                  ? parseFloat(firstRect.getAttribute("height"))
                  : portW;

                const spanX = Math.max(0, w - portW);
                const spanY = Math.max(0, h - portH);
                const ratio = (spanY > 0) ? (spanX / spanY) : spanX;

                const cols = Math.max(1, Math.round(Math.sqrt(n * (ratio || 1))));
                const rows = Math.max(1, Math.ceil(n / cols));
                const stepX = (cols > 1) ? (spanX / (cols - 1)) : 0;
                const stepY = (rows > 1) ? (spanY / (rows - 1)) : 0;

                const baseX = Number(b.x) || 0;
                const baseY = Number(b.y) || 0;

                arr.forEach((p, idx) => {
                  const c = idx % cols;
                  const r = Math.floor(idx / cols);
                  const x = baseX + stepX * c;
                  const y = baseY + stepY * r;
                  setPortXY(p.id, applySnap(x), applySnap(y));
                });
              };
	              placeInBox(uplinks, box);
	            }

	            this._calibDirty = true;
	            if (elAdv?.style?.display !== "none") refreshExport();
	            refreshSelCount();
	          };

	          applyAutoLayout(pt1, pt2);
	          setMsg("Done");
	          setTimeout(() => setMsg(""), 1200);
	
	          window.removeEventListener("pointermove", onMove);
	          window.removeEventListener("pointerup", onUp);
	          return;
	        }
	        if (isPb && pbActive) {
          // Commit ports box changes (do not persist until user clicks Save)
          const pbWasMove = (pbKind === "move");
          pbActive = false;
          pbPid = null;
          pbHandle = null;
          pbStart = null;
          pbOrig = null;
          pbMoveStartPositions = null;
          pbResizeStartPositions = null;
          // Keep the ports box visible while the Ports box tool remains active,
          // so users can immediately grab handles to resize (same UX as Uplinks box).
          if (this._calibPortsBoxMode) setPortsBoxVisible(true);
          updatePortsBoxSvg();
                    setMsg("");
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          commitUndo();
          pbKind = null;
          return;
        }

        if (isUb && ubActive) {
          // Commit uplinks box changes
          const ubWasMove = (ubKind === "move");
          ubActive = false;
          ubPid = null;
          ubHandle = null;
          ubStart = null;
          ubOrig = null;
          ubMoveStartPositions = null;
          ubResizeStartPositions = null;
          // Do NOT persist layout editor changes until the user explicitly clicks Save.
          // Match Ports box behavior: when finishing a draw/resize/move, tighten the
          // box around current uplink port positions (no padding) so it hugs ports.
          try { fitUplinkBoxToPorts(); } catch (e) {}
          updateUplinkBoxSvg();
          // Do not auto-pack uplinks on resize/draw end; user-driven box is authoritative.
          setMsg("");
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          commitUndo();
          ubKind = null;
          return;
        }
if (boxSelecting && boxStart) {
          const x1 = boxStart.x, y1 = boxStart.y;
          const x2 = pt.x, y2 = pt.y;
          const rx = Math.min(x1, x2);
          const ry = Math.min(y1, y2);
          const rw = Math.abs(x2 - x1);
          const rh = Math.abs(y2 - y1);
          clearMarquee();

          const gs = Array.from(root.querySelectorAll(".port-svg[data-entity]"));
          const next = new Set();
          gs.forEach(g => {
            const r = getPortRect(g);
            if (!r) return;
            const x = parseFloat(r.getAttribute("x"));
            const y = parseFloat(r.getAttribute("y"));
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) {
              const id = g.getAttribute("data-entity");
              if (id) next.add(id);
            }
          });
          this._calibSel = next;
          refreshSelCount();
          refreshSelectionStyles();
          setMsg("");
        }

        boxSelecting = false;
        boxPid = null;
        boxStart = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      hit.addEventListener("pointermove", (ev) => {
        const pt = this._svgPoint(svg, ev.clientX, ev.clientY);
        if (elXY) elXY.textContent = `${Math.round(pt.x)}, ${Math.round(pt.y)}`;
      });

      // Uplinks box: move/resize via rect + handles (only when mode is active)
      // Ports box: move/resize via rect + handles (only when mode is active)
      const startPbDrag = (ev, kind, handle) => {
        if (!this._calibPortsBoxMode) return;
        ev.preventDefault();
        ev.stopPropagation();
        beginUndo();
        const pt = this._svgPoint(svg, ev.clientX, ev.clientY);
        pbActive = true;
        pbPid = ev.pointerId;
        pbKind = kind;
        pbHandle = handle || null;
        pbStart = pt;
        pbOrig = normBox(this._calibPortsBox) || { x: pt.x, y: pt.y, w: 240, h: 160 };
        // If moving the Ports box, treat it as a container: move physical (non-uplink) ports with it.
        pbMoveStartPositions = null;
        pbResizeStartPositions = null;
        try {
          const uplSet = new Set(((this._config?.uplink_ports || [])).map(s => String(s).trim().toLowerCase()).filter(Boolean));
          const gs = Array.from(svg.querySelectorAll(".port-svg[data-entity]"));
          const map = new Map();
          gs.forEach(g => {
            const id = g.getAttribute("data-entity");
            if (!id) return;
            const nm = String(g.getAttribute("data-portname") || "").trim().toLowerCase();
            if (uplSet.has(nm)) return; // leave uplinks to the uplinks box
            const r = getPortRect(g);
            if (!r) return;
            const x = Number(r.getAttribute("x"));
            const y = Number(r.getAttribute("y"));
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            map.set(id, { x, y });
          });
          if (kind === "move") pbMoveStartPositions = map;
          if (kind === "resize") pbResizeStartPositions = map;
        } catch (e) {
          pbMoveStartPositions = null;
          pbResizeStartPositions = null;
        }

        setPortsBoxVisible(true);
        updatePortsBoxSvg();
        try { ev.target.setPointerCapture(ev.pointerId); } catch (e) {}
        window.addEventListener("pointermove", onMove, { passive: false });
        window.addEventListener("pointerup", onUp, { passive: false });
      };

      if (portsRect && !portsRect._ssmBound) {
        portsRect._ssmBound = true;
        portsRect.addEventListener("pointerdown", (ev) => startPbDrag(ev, "move", null));
      }
      portsHandles.forEach(h => {
        if (h._ssmBound) return;
        h._ssmBound = true;
        h.addEventListener("pointerdown", (ev) => startPbDrag(ev, "resize", h.getAttribute("data-h")));
      });

      const startUbDrag = (ev, kind, handle) => {
        if (!this._calibUplinkBoxMode) return;
        ev.preventDefault();
        ev.stopPropagation();
        beginUndo();
        const pt = this._svgPoint(svg, ev.clientX, ev.clientY);
        ubActive = true;
        ubPid = ev.pointerId;
        ubKind = kind;
        ubHandle = handle || null;
        ubStart = pt;
        ubOrig = normBox(this._calibUplinkBox) || { x: pt.x, y: pt.y, w: 140, h: 100 };
        // If moving the Uplinks box, treat it as a container: move uplink ports with it.
        ubMoveStartPositions = null;
        ubResizeStartPositions = null;
        try {
          const uplSet = new Set(((this._config?.uplink_ports || [])).map(s => String(s).trim().toLowerCase()).filter(Boolean));
          const gs = Array.from(svg.querySelectorAll(".port-svg[data-entity]"));
          const map = new Map();
          gs.forEach(g => {
            const id = g.getAttribute("data-entity");
            if (!id) return;
            const nm = String(g.getAttribute("data-portname") || "").trim().toLowerCase();
            if (!uplSet.has(nm)) return;
            const r = getPortRect(g);
            if (!r) return;
            const x = Number(r.getAttribute("x"));
            const y = Number(r.getAttribute("y"));
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            map.set(id, { x, y });
          });
          if (kind === "move") ubMoveStartPositions = map;
          if (kind === "resize") ubResizeStartPositions = map;
        } catch (e) {
          ubMoveStartPositions = null;
          ubResizeStartPositions = null;
        }

        setUplinkBoxVisible(true);
        updateUplinkBoxSvg();
        try { ev.target.setPointerCapture(ev.pointerId); } catch (e) {}
        window.addEventListener("pointermove", onMove, { passive: false });
        window.addEventListener("pointerup", onUp, { passive: false });
      };

      if (uplRect && !uplRect._ssmBound) {
        uplRect._ssmBound = true;
        uplRect.addEventListener("pointerdown", (ev) => startUbDrag(ev, "move", null));
      }
      uplHandles.forEach(h => {
        if (h._ssmBound) return;
        h._ssmBound = true;
        h.addEventListener("pointerdown", (ev) => startUbDrag(ev, "resize", h.getAttribute("data-h")));
      });


	      hit.addEventListener("pointerdown", (ev) => {
	        // Auto layout: click + drag to draw the bounds
	        if (this._calibAssist === "drag") {
	          const pt = this._svgPoint(svg, ev.clientX, ev.clientY);
	          saDragging = true;
	          saPid = ev.pointerId;
	          saStart = pt;
	          this._calibAssistPt1 = pt;
	          try { hit.setPointerCapture(ev.pointerId); } catch (e) {}
	          window.addEventListener("pointermove", onMove, { passive: false });
	          window.addEventListener("pointerup", onUp, { passive: false });
	          return;
	        }

        // Ports box draw
        if (this._calibPortsBoxMode) {
          beginUndo();
          pbActive = true;
          pbPid = ev.pointerId;
          pbKind = "draw";
          pbHandle = null;
          pbStart = this._svgPoint(svg, ev.clientX, ev.clientY);
          pbOrig = null;
          setPortsBoxVisible(true);
          updatePortsBoxSvg();
          try { hit.setPointerCapture(ev.pointerId); } catch (e) {}
          window.addEventListener("pointermove", onMove, { passive: false });
          window.addEventListener("pointerup", onUp, { passive: false });
          return;
        }

        // Box select / Uplinks box draw
        if (this._calibUplinkBoxMode) {
          // Draw a new uplinks box (marquee-style)
          beginUndo();
          ubActive = true;
          ubPid = ev.pointerId;
          ubKind = "draw";
          ubHandle = null;
          ubStart = this._svgPoint(svg, ev.clientX, ev.clientY);
          ubOrig = null;
          setUplinkBoxVisible(true);
          updateUplinkBoxSvg();
          try { hit.setPointerCapture(ev.pointerId); } catch (e) {}
          window.addEventListener("pointermove", onMove, { passive: false });
          window.addEventListener("pointerup", onUp, { passive: false });
          return;
        }

        boxSelecting = true;
        boxPid = ev.pointerId;
        boxStart = this._svgPoint(svg, ev.clientX, ev.clientY);
        try { hit.setPointerCapture(ev.pointerId); } catch (e) {}
        window.addEventListener("pointermove", onMove, { passive: false });
        window.addEventListener("pointerup", onUp, { passive: false });
}, { passive: true });
    }

    // Clicking + dragging ports: selection + group move
    root.querySelectorAll(".port-svg[data-entity]").forEach(g => {
      if (g._ssmCalibBound) return;
      g._ssmCalibBound = true;

      let dragging = false;
      let dragPointerId = null;
      let dragStartPt = null;
      let dragStartPositions = null;
      let dragUplinkIds = null;

      const onMove = (ev) => {
        if (!dragging || dragPointerId !== ev.pointerId || !dragStartPt || !dragStartPositions) return;
        ev.preventDefault();
        const pt = this._svgPoint(svg, ev.clientX, ev.clientY);
        const dx = pt.x - dragStartPt.x;
        const dy = pt.y - dragStartPt.y;

        dragStartPositions.forEach((pos, id) => {
          let x = applySnap(pos.x + dx);
          let y = applySnap(pos.y + dy);
          setPortXY(id, x, y);
        });

        // Keep the Uplinks box enclosing uplink ports while dragging (without constraining movement).
        if (this._config?.show_uplinks_separately) {
          try {
            const uplSet = new Set(((this._config?.uplink_ports || [])).map(s => String(s).trim().toLowerCase()).filter(Boolean));
            if (uplSet.size) {
              const uplRects = Array.from(svg.querySelectorAll('.port-svg[data-entity]'))
                .filter(g => uplSet.has(String(g.getAttribute('data-portname') || '').trim().toLowerCase()))
                .map(g => getPortRect(g))
                .filter(Boolean);

              if (uplRects.length) {
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                uplRects.forEach(r => {
                  const x = Number(r.getAttribute('x'));
                  const y = Number(r.getAttribute('y'));
                  const w = Number(r.getAttribute('width'));
                  const h = Number(r.getAttribute('height'));
                  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return;
                  minX = Math.min(minX, x);
                  minY = Math.min(minY, y);
                  maxX = Math.max(maxX, x + w);
                  maxY = Math.max(maxY, y + h);
                });

                if (Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)) {
                  const pad = 0;
                  const nx = Math.max(0, minX - pad);
                  const ny = Math.max(0, minY - pad);
                  const nw = Math.max(1, (maxX - minX) + (2 * pad));
                  const nh = Math.max(1, (maxY - minY) + (2 * pad));
                  this._calibUplinkBox = { x: nx, y: ny, w: nw, h: nh };
                  updateUplinkBoxSvg();
                }
              }
            }
          } catch (e) {}
        }

if (elAdv?.style?.display !== "none") refreshExport();
        this._calibDirty = true;
      };

      const onUp = (ev) => {
        if (dragPointerId !== ev.pointerId) return;
        try { g.releasePointerCapture(ev.pointerId); } catch (e) {}
        dragging = false;
        dragPointerId = null;
        dragStartPt = null;
        dragStartPositions = null;
        dragUplinkIds = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);

        commitUndo();
      };

      g.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        const id = g.getAttribute("data-entity");
        if (!id) return;

        // Selection logic
        if ((ev.ctrlKey || ev.metaKey)) {
          if (this._calibSel.has(id)) this._calibSel.delete(id);
          else this._calibSel.add(id);
        } else {
          // If the clicked port is already part of the current multi-selection,
          // keep the selection so users can drag the whole group.
          // Only collapse to a single-item selection when clicking a different port.
          if (!this._calibSel.has(id)) {
            this._calibSel = new Set([id]);
          }
        }
        refreshSelCount();
        refreshSelectionStyles();

        // Track in-memory undo history for any drag/move operations.
        beginUndo();

        // Begin group drag for current selection
        dragging = true;
        dragPointerId = ev.pointerId;
        dragStartPt = this._svgPoint(svg, ev.clientX, ev.clientY);
        dragStartPositions = new Map();
        dragUplinkIds = new Set();

        // Determine which selected ports are uplinks (by Port Name match to uplink_ports).
        const _uplinkSet = new Set(((this._config?.uplink_ports || [])).map(s => String(s).trim().toLowerCase()).filter(Boolean));
        const _separate = !!this._config?.show_uplinks_separately;

        this._calibSel.forEach(selId => {
          const gg = root.querySelector(`.port-svg[data-entity="${CSS.escape(selId)}"]`);
          const xy = getGXY(gg);
          if (xy) dragStartPositions.set(selId, { x: xy.x, y: xy.y });

          if (_separate && _uplinkSet.size && gg) {
            const pn = String(gg.getAttribute("data-portname") || "").trim().toLowerCase();
            if (pn && _uplinkSet.has(pn)) dragUplinkIds.add(selId);
          }
        });

        try { g.setPointerCapture(ev.pointerId); } catch (e) {}
        window.addEventListener("pointermove", onMove, { passive: false });
        window.addEventListener("pointerup", onUp, { passive: false });
      }, { passive: false });
    });

    // Initial refresh
    refreshSelCount();
    refreshSelectionStyles();
    if (elSnap) elSnap.value = String(this._calibSnap || 0);
    if (elAdv?.style?.display !== "none") refreshExport();
  }



  async _render() {
    if (!this.shadowRoot || !this._config || !this._hass) return;

    const data = await this._discoverEntities(); if (!data) return;
    let { phys, virt, diag } = data;

    // Enforce Hide ports at render-time as a final guard (prevents any discovery path from re-introducing hidden ports)
    const __hideSet = new Set(((this._config?.hide_ports || [])).map(s => String(s).trim().toLowerCase()).filter(Boolean));
    if (__hideSet.size) {
      const _isHidden = (id, st) => {
        const a = st?.attributes || {};
        const nRaw = String(a.Name || a.name || "").trim();
        const nKey = nRaw.toLowerCase();
        const idKey = String(id || "").trim().toLowerCase();
        return (nKey && __hideSet.has(nKey)) || (idKey && __hideSet.has(idKey));
      };
      phys = phys.filter(([id, st]) => !_isHidden(id, st));
      virt = virt.filter(([id, st]) => !_isHidden(id, st));
    }

    const style = `
      :host { display:block; }
      ha-card { display:block; }
      .head { font-size: 18px; font-weight: 600; padding: 12px 16px; border-bottom: 1px solid var(--divider-color); }
      .section { padding: 12px 16px; }
      .hint { opacity:.85; }
      .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(170px,1fr)); gap:10px; }
      .subhead { font-weight:700; margin: 0 0 8px; }
      .subsection { margin-top: 14px; }
      .port { border:1px solid var(--divider-color); border-radius:12px; padding:10px; background:var(--card-background-color); }
      /* IMPORTANT: label_font_color is for Panel (SVG) labels only.
         List view port names must always stay themed (primary text). */
      .name { font-weight:700; margin-bottom:6px; cursor:pointer; color: var(--primary-text-color) !important; }
      .kv { font-size:12px; color:var(--secondary-text-color); margin-bottom:10px; }
      .dot { width:10px; height:10px; border-radius:50%; display:inline-block; margin-right:6px; }
      .btn { font:inherit; padding:10px 12px; border-radius:10px; border:1px solid var(--divider-color); background:var(--secondary-background-color); cursor:pointer; }
      .btn:active { transform: translateY(1px); }
      .btn.wide { width:100%; text-align:center; }

      /* Info grid */
      .info-grid { display:grid; grid-template-columns: 1fr 1fr; gap:12px; padding: 0 16px 8px; }
      @media (max-width: 860px) { .info-grid { grid-template-columns: 1fr; } }
      .box { border:1px solid var(--divider-color); border-radius:12px; padding:10px; background:var(--card-background-color); }

      .virt-title { font-weight:700; margin-bottom:6px; }
      .virt-row { display:flex; align-items:center; gap:8px; padding:6px 0; font-size:14px; }
      .virt-name { cursor:pointer; }
      .virt-row .btn { padding:6px 10px; font-size:12px; margin-left:auto; }

      .diag-title { font-weight:700; margin-bottom:6px; }
      .diag-row { display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px dashed var(--divider-color); }
      .diag-name { opacity:.9; }
      .diag-val { opacity:.8; }

      /* Panel */
      .panel { padding: 8px 12px 6px; }
      svg { display:block; }
      svg[data-ssm-panel] { touch-action: none; }
      .port-svg { touch-action: none; }
      .portlabel{ font-size: ${this._config.label_size}px; color: ${this._config.label_color ? this._config.label_color : "var(--primary-text-color)"}; opacity:.85; }
      .panel-wrap { border-radius:12px; border:1px solid var(--divider-color); width:100%; box-sizing:border-box;
        /* Prefer HA theme vars; fall back to card background for themes that don't set --ha-card-background */
        padding:6; background: color-mix(in oklab, var(--ha-card-background, var(--card-background-color, #1f2937)) 75%, transparent); }
      /* Keep background aligned to the top so enabling labels doesn't visually "push" the image down.
         When the panel height changes (e.g., label rows), centered backgrounds will appear to shift. */
      .panel-wrap.bg { background-repeat:no-repeat; background-position:top center; background-size: contain; }

      .port-svg.calib-selected rect { stroke: rgba(255,255,255,.9); stroke-width: 2; }
      .calib-tools{ margin:12px 16px 16px 16px; padding:12px; border:1px dashed var(--divider-color); border-radius:12px; background:rgba(0,0,0,.12); }
      .calib-row{ display:flex; justify-content:space-between; align-items:baseline; gap:12px; flex-wrap:wrap; }
      .calib-title{ font-weight:700; }
      .calib-status{ font-size:12px; color:var(--secondary-text-color); }
      .calib-hint{ margin-top:6px; font-size:12px; color:var(--secondary-text-color); }
      #ssm-calib-json{ width:100%; margin-top:10px; font-family:var(--code-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace);
        font-size:12px; padding:10px; border-radius:10px; border:1px solid var(--divider-color); background:var(--card-background-color); color:var(--primary-text-color); box-sizing:border-box;
        height: 220px; overflow:auto; overscroll-behavior: contain; }
      .calib-actions{ display:flex; gap:8px; justify-content:flex-start; margin-top:10px; flex-wrap:wrap; }
      .calib-actions .iconbtn{ width:36px; height:36px; border-radius:10px; background: var(--card-background-color); box-shadow: 0 1px 2px rgba(0,0,0,0.25); border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; padding:0; color: var(--primary-text-color); }
      .calib-actions .iconbtn ha-icon{ --mdc-icon-size:20px; }
      .calib-actions .iconbtn:hover{ filter: brightness(1.08); }
      
      .calib-inline{ display:flex; align-items:center; gap:6px; font-size:12px; color:var(--secondary-text-color); padding:4px 8px; border:1px solid var(--divider-color); border-radius:10px; }
      .calib-inline select{ background:var(--card-background-color); color:var(--primary-text-color); border:1px solid var(--divider-color); border-radius:8px; padding:4px 6px; }
      
      .calib-snap-input{ width:86px; height:32px; min-height:32px; max-height:32px; padding:0 8px; box-sizing:border-box; border-radius:8px; border:1px solid var(--divider-color); background:var(--card-background-color); color:var(--primary-text-color); font-size:12px; line-height:32px; text-align:center; }
      .calib-snap-input:focus{ outline:none; border-color:var(--primary-color); }
.calib-msg{ margin-left:8px; }

    
      /* Auto-scale wrapper (responsive on large displays like 4K) */
      .autoscale-outer{ width:100%; overflow:visible; }
      .autoscale-inner{ transform-origin: top left; will-change: transform; }
`;

    const header = this._config.title ? `<div class="head">${this._config.title}</div>` : "";

    if (diag && !phys.length && !virt.length && !this._config.ports) {
      const diagList = diag.map(id => `<code>${id}</code>`).join(", ");
      this.shadowRoot.innerHTML = `
        <ha-card>
          <style>${style}</style>
          ${header}
          <div class="section"><div class="hint">
            Auto-discovery found no matching ports.<br/>
            First 20 <b>switch.*</b> entities: ${diagList || "<i>(none)</i>"}
          </div></div>
        </ha-card>`;
      // Re-attach modal/style if open
      if (this._modalStyle) this.shadowRoot.append(this._modalStyle);
      if (this._modalEl) this.shadowRoot.append(this._modalEl);
      this._reattachTransientModals();
      return;
    }

    // Info grid (Diagnostics + Virtual)
    const infoGrid = (() => {
      const diagBox = (() => {
        if (this._config.hide_diagnostics) return "";
        const diagIds = this._getDiagnosticsEntityIds();
        if (!diagIds.length) return "";
        const H = this._hass?.states || {};
        const rows = diagIds.map(id => {
          // Attribute-backed diagnostic: "sensor.x#Attribute Name"
          if (String(id).includes("#")) {
            const [eid, attr] = String(id).split("#");
            const st = H[eid];
            if (!st) return null;
            const v = st?.attributes?.[attr];
            if (v == null) return null;
            const name = attr; // already human-readable (comes from integration attribute names)
            const value = (typeof v === "string") ? v : (Number.isFinite(v) ? String(v) : JSON.stringify(v));
            return `<div class="diag-row"><span class="diag-name">${name}</span><span class="diag-val">${value}</span></div>`;
          }

          const st = H[id]; if (!st) return null;
          let name = st.attributes?.friendly_name || id;
          // Friendly names often include the device prefix (e.g. "SWITCH-XYZ Hostname"); strip it for display.
          name = this._stripDiagPrefix(name);
          const value = typeof st.state === "string" ? st.state : JSON.stringify(st.state);
          return `<div class="diag-row"><span class="diag-name">${name}</span><span class="diag-val">${value}</span></div>`;
        }).filter(Boolean).join("");
        if (!rows) return "";
        return `<div class="box"><div class="diag-title">Diagnostics</div>${rows}</div>`;
      })();

      const virtBox = (() => {
        if (this._config.hide_virtual_interfaces) return "";
        if (!virt.length) return "";
        const rows = virt.filter(([id, st]) => {
          const a = st.attributes || {};
          const n = a.Name || id.split(".")[1] || id;
          return !_ssmIsHiddenPort(this._config, n, id);
        }).map(([id, st]) => {
          const a = st.attributes || {};
          const n = a.Name || id.split(".")[1] || id;
          const ip = a.IP ? ` — ${a.IP}` : "";
          const alias = a.Alias;
          const titleParts = [];
          if (alias) titleParts.push(`${alias}`);
          titleParts.push(`${n}${ip}`);
          const title = titleParts.join(" • ");
          const btn = this._config.hide_control_buttons
            ? ""
            : `<button class="btn" data-entity="${id}">${this._buttonLabel(st)}</button>`;
          return `<div class="virt-row" title="${title}">
            <span class="dot" style="background:${this._colorFor(st)}"></span>
            <span class="virt-name" data-alias-entity="${id}">${n}${ip}</span>
            ${btn}
          </div>`;
        }).join("");
        return `<div class="box"><div class="virt-title">Virtual Interfaces</div>${rows}</div>`;
      })();

      // NOTE: "Show uplinks separately" is a Layout Editor feature only.
      // Uplinks should NOT appear as a separate box in the rendered card.
      if (!diagBox && !virtBox) return "";
      return `<div class="info-grid">${diagBox}${virtBox}</div>`;
    })();

    const listView = () => {
      // NOTE: "Show uplinks separately" is a Layout Editor feature only.
      // In List view we do NOT split uplinks into a separate section.

      const visiblePhys = phys.filter(([id, st]) => {
        const a = st.attributes || {};
        const name = a.Name || id.split(".")[1] || "";
        return !_ssmIsHiddenPort(this._config, name, id);
      });

      const mainPhys = visiblePhys;

      const renderPort = ([id, st]) => {
        const a = st.attributes || {};
        const name = a.Name || id.split(".")[1];
        const ip = a.IP ? ` • IP: ${a.IP}` : "";
        const alias = a.Alias;
        const titleParts = [];
        if (alias) titleParts.push(`${alias}`);
        titleParts.push(`${name}${ip}`);
        const title = titleParts.join(" • ");
        const btn = this._config.hide_control_buttons
          ? ""
          : `<button class="btn wide" data-entity="${id}">${this._buttonLabel(st)}</button>`;
        return `<div class="port" title="${title}">
          <div class="name" data-alias-entity="${id}">${name}</div>
          <div class="kv"><span class="dot" style="background:${this._colorFor(st)}"></span>
            ${this._config.color_mode === "speed" ? `Speed: ${(this._speedLabelFromAttrs(a) || a.Speed || a.speed || "-")}` : `State: ${(a.Admin ?? "-")}/${(a.Oper ?? "-")}`}${ip}
          </div>
          ${btn}
        </div>`;
      };

      const mainGrid = mainPhys.map(renderPort).join("");

      return `
        <div class="autoscale-outer"><div class="autoscale-inner">
        ${this._config.info_position === "above" ? infoGrid : ""}
        <div class="section">
          ${mainPhys.length ? `
            <div class="grid">${mainGrid}</div>
          ` : `<div class="hint">No physical ports discovered.</div>`}
        </div>
        ${this._config.info_position === "below" ? infoGrid : ""}
        </div></div>`;
    };

    const panelView = () => {
      // Prefer physical ports, but if none were discovered fall back to virtual
      // so devices whose ports are only exposed as "virtual" (e.g. D-Link Slot0/x)
      // still render correctly in panel mode.
      const panelPorts = phys.length ? phys : virt;

      const useBg = !!this._config.background_image;
      const bgUrl = useBg ? this._htmlEscape(this._config.background_image) : "";
      const scale = (Number.isFinite(this._config.ports_scale) && this._config.ports_scale > 0) ? this._config.ports_scale : 1;
      const offX = Number.isFinite(this._config.ports_offset_x) ? this._config.ports_offset_x : 0;
      const offY = Number.isFinite(this._config.ports_offset_y) ? this._config.ports_offset_y : 0;


      const P = this._config.port_size;
      const Gh = Number(this._config.horizontal_port_gap);
      const Gv = Number(this._config.vertical_port_gap);
      const perRow = Math.max(1, this._config.ports_per_row);
      const rows = Math.max(1, Math.ceil((panelPorts.length || perRow) / perRow));
      let W = Number(this._config.panel_width);
      if (!Number.isFinite(W)) W = 740;
      const sidePad = 28;

      const totalGridH = rows * P + Math.max(0, rows - 1) * (Number.isFinite(Gv) ? Gv : 0);
      const labelPos = String(this._config.label_position || "below");
      const fs0 = Math.max(8, Number(this._config.label_size) || 8);
      // Reserve a little space for below-labels so they don’t clip. For inside/above, minimal padding.
      const labelPad = (this._config.show_labels && (labelPos !== "inside") && (labelPos !== "above") && (labelPos !== "split"))
        ? (fs0 + 10)
        : 12;

      const totalRowW = perRow * P + Math.max(0, (perRow - 1)) * (Number.isFinite(Gh) ? Gh : 0);

      if (W <= 0) {
        // Panel width = 0 means "auto".
        // IMPORTANT:
        // - The SVG is rendered at width="100%" (responsive to the card's available space).
        // - If we compute a *small* viewBox width from the port grid, the browser will scale that
        //   small viewBox up to the available width, which also scales the height and creates the
        //   huge empty vertical space you observed in auto mode.
        //
        // So, in auto mode, keep a sane, "screen-like" baseline viewBox width. The browser will
        // scale it to the available width, but the viewBox aspect remains stable so the background
        // image stays in aspect and we avoid the bottom gap.
        W = 980;
      }

      // Panel height:
      // - If a background image is configured and we know its aspect ratio, match panel height
      //   to preserve the image aspect (no stretching and no unnecessary letterboxing).
      // - Otherwise fall back to content-driven height.
      let H = Math.max(140, Math.ceil(totalGridH + labelPad + 48));
      if (useBg) {
        try { this._maybeLoadBgAspect(); } catch (e) {}
        const asp = this._bgAspectByUrl.get(String(this._config.background_image || "").trim());
        if (Number.isFinite(asp) && asp > 0 && Number.isFinite(W) && W > 0) {
          H = Math.max(140, Math.round(W / asp));
        }
      }

      // Center ports vertically within the panel.
      let topPad = Math.max(12, Math.floor((H - totalGridH - labelPad) / 2));
      let maxBottom = H;
      let maxRight = W;
      let plate = "";
const usableW = W - 2 * sidePad;
const startX = sidePad + Math.max(0, (usableW - totalRowW) / 2);
		// Optional per-port positioning overrides (panel view)
      // Map keys are interface Names (e.g. "Gi1/0/1"). Matching is case-insensitive.
      // When calibration mode is enabled we may have a live (in-memory) map that differs from
      // config.port_positions. Use the live map so drag/drop doesn't snap back on refresh.
      const stored = this._loadCalibMapFromStorage();
      const storedMap = stored ? stored.map : null;

      // Precedence:
      // 1) Live map while Layout Editor is active
      // 2) Persisted layout from localStorage (applies even when Layout Editor is off)
      // 3) Config-provided port_positions (legacy/manual)
      const portPosRaw = (this._isCalibrationEnabled() && this._calibMap && typeof this._calibMap === "object")
        ? this._calibMap
        : ((storedMap && typeof storedMap === "object")
            ? storedMap
            : ((this._config.port_positions && typeof this._config.port_positions === "object")
                ? this._config.port_positions
                : null));
      const portPos = portPosRaw
        ? new Map(Object.entries(portPosRaw).map(([k, v]) => [String(k).trim().toLowerCase(), v]))
        : null;

      const labels = [];

      // For "Split (2 row)" labels, decide above/below by actual Y position (top vs bottom row),
      // rather than by i/perRow (which can be wrong when portsPerRow doesn't match the rendered rows).
      let _splitMidY = null;
      const _labelPosMode = (this._config.label_position || "below");
      if (this._config.show_labels && _labelPosMode === "split") {
        let _minY = Infinity;
        let _maxY = -Infinity;
        for (let _i = 0; _i < panelPorts.length; _i++) {
          const [_id, _st] = panelPorts[_i];
          const _a = (_st && _st.attributes) ? _st.attributes : {};
          const _name = String(_a.Name || String(_id || "").split(".")[1] || "");
          if (_ssmIsHiddenPort(this._config, _name, _id)) continue;

          const _idx = _i % perRow, _row = Math.floor(_i / perRow);
          let _x = startX + _idx * (P + Gh);
          let _y = topPad + _row * (P + Gv) ;

          if (portPos) {
            const _key = String(_name).trim().toLowerCase();
            const _ov = portPos.get(_key) || portPos.get(String(((_id || "").split(".")[1] || "")).trim().toLowerCase());
            if (_ov && typeof _ov === "object") {
              const _ox = Number(_ov.x);
              const _oy = Number(_ov.y);
              if (Number.isFinite(_ox)) _x = _ox;
              if (Number.isFinite(_oy)) _y = _oy;
            }
          }

          _x += offX;
          _y += offY;

          if (Number.isFinite(_y)) {
            if (_y < _minY) _minY = _y;
            if (_y > _maxY) _maxY = _y;
          }
        }
        if (Number.isFinite(_minY) && Number.isFinite(_maxY) && _maxY > _minY) {
          _splitMidY = (_minY + _maxY) / 2;
        }
      }
      const rects = panelPorts.map(([id, st], i) => {
        const a = st.attributes || {};
        const name = String(a.Name || id.split(".")[1] || "");
        if (_ssmIsHiddenPort(this._config, name, id)) return "";
        const alias = a.Alias;
        const idx = i % perRow, row = Math.floor(i / perRow);
        let x = startX + idx * (P + Gh);
        let y = topPad + row * (P + Gv) ;

        // Apply explicit position override if provided (values are SVG coords for the port's top-left).
        if (portPos) {
          const key = String(name).trim().toLowerCase();
          const ov = portPos.get(key) || portPos.get(String((id || "").split(".")[1] || "").trim().toLowerCase());
          if (ov && typeof ov === "object") {
            const ox = Number(ov.x);
            const oy = Number(ov.y);
            if (Number.isFinite(ox)) x = ox;
            if (Number.isFinite(oy)) y = oy;
          }
        }

        // Global offsets (px) are applied after any per-port overrides.
        x += offX;
        y += offY;
        const fill = this._colorFor(st);
        const Ps = P * scale;
        // Ensure the SVG viewBox grows to include any custom-positioned ports.
// (Label extents are accounted for after label geometry is computed.)
if (Number.isFinite(y) && Number.isFinite(Ps)) {
  maxBottom = Math.max(maxBottom, y + Ps + 12);
  maxRight = Math.max(maxRight, x + Ps + 12);
}
        const labelColor = this._config.label_color || this._config.label_font_color || "var(--primary-text-color)";
        const labelBg = this._config.label_bg_color || this._config.label_background_color || "";
        if (this._config.show_labels) {
          const fs = Math.max(1, Number(this._config.label_size) || 8);
          const rawNm = String(name);
          const numbersOnly = !!this._config.label_numbers_only;
          const nm = (() => {
            if (!numbersOnly) return rawNm;
            const s = rawNm;
            // Numbers-only labels: choose source
            const from = String(this._config.label_numbers_from ?? "index").toLowerCase();
            if (from === "index") {
              const ifidx = (a.Index ?? a.IfIndex ?? a.ifIndex ?? a.ifindex ?? null);
              const v = Number.isFinite(Number(ifidx)) ? Number(ifidx) : (i + 1);
              return String(v);
            }
            // Port name: use the right-most number anywhere in the port name (e.g. "GigabitEthernet 3" -> "3", "Gi1/0/47" -> "47")
            const nums = s.match(/\d+/g);
            return (nums && nums.length) ? nums[nums.length - 1] : s;
          })();
          // Make the background as tight as practical while staying readable.
          // SVG text is proportional; this is an estimate, not a measurement.
          const padX = 1.2;
          const padY = 1.4;
          const estW = Math.max(6, (nm.length * fs * 0.48) + (padX * 2));
          const rectX = (x + Ps / 2) - (estW / 2);
          const rectH = fs + (padY * 2);
          let pos = (this._config.label_position || "below");
          if (pos === "split") {
            // Split (2 row): top row labels above, bottom row labels below.
            // Use actual Y midpoint so we split by rendered rows even with non-standard perRow.
            pos = (_splitMidY != null && y <= _splitMidY) ? "above" : "below";
          }          // Labels are overlay-only. We keep them inside the existing SVG bounds so they do not
          // change panel height (unless the user explicitly makes the panel smaller than labels).

          // Keep labels perfectly centered when position is "inside" by anchoring to the port center.
          const isInside = (pos === "inside");
          const desiredY = (pos === "above")
            ? (y - rectH - 2)
            : isInside
              ? (y + (Ps - rectH) / 2)
              : (y + Ps + 2);

          // Clamp above/below labels to the viewBox bounds; for inside, allow natural centering.
          const rectY = isInside
            ? desiredY
            : Math.min(Math.max(desiredY, 2), Math.max(2, H - rectH - 2));

          const bg = String(labelBg || "").trim();
          const bgRect = bg
            ? `<rect class="portlabel-bg" data-entity="${id}" x="${rectX}" y="${rectY}" width="${estW}" height="${rectH}" rx="2" ry="2" fill="${bg}" style="pointer-events:none"></rect>`
            : "";

          const textX = (x + Ps / 2);
          // "dominant-baseline: middle" can render a hair high depending on font metrics.
          // Nudge down slightly for consistent visual centering in the port.
          const insideNudge = Math.max(0.5, fs * 0.12);
          const textY = isInside ? (y + Ps / 2 + insideNudge) : (rectY + fs + padY - 0.5);
          const dominant = isInside ? "middle" : "alphabetic";

          labels.push(`${bgRect}<text class="portlabel" data-entity="${id}" x="${textX}" y="${textY}" text-anchor="middle" dominant-baseline="${dominant}" style="${(this._config.label_outline) ? 'paint-order:stroke fill;stroke:#000;stroke-width:2px;stroke-linejoin:round;' : ''} pointer-events:none; fill:${labelColor};" fill="${labelColor}">${nm}</text>`);
        }
        const titleParts = [];
        if (alias) titleParts.push(`${alias}`);
        titleParts.push(name);
        const title = this._htmlEscape(titleParts.join(" • "));
        return `
          <g class="port-svg" data-entity="${id}" data-portname="${this._htmlEscape(name)}" tabindex="0" style="cursor:pointer">
            <title>${title}</title>
            <rect x="${x}" y="${y}" width="${Ps}" height="${Ps}" rx="${Math.round(Ps * 0.2)}"
              fill="${fill}" stroke="rgba(0,0,0,.35)"/>
            </g>`;
      }).join("");

      // Expand viewBox height if custom positions extend beyond the default grid.
      H = Math.max(H, Math.ceil(maxBottom));

      // Expand viewBox width if custom positions or Layout Editor boxes extend beyond the default grid.
      // IMPORTANT: when Panel width is 0 (auto), expanding the viewBox during editing changes the
      // scale between Layout Editor and normal view, which makes ports appear to “move/resize”
      // after exiting the editor. So only expand for boxes when the user has an explicit panel width.
      const _panelWCfg = Number(this._config.panel_width);
      if (this._isCalibrationEnabled() && Number.isFinite(_panelWCfg) && _panelWCfg > 0) {
        const bump = (b) => {
          if (!b || typeof b !== "object") return;
          const bx = Number(b.x), by = Number(b.y), bw = Number(b.w), bh = Number(b.h);
          if (Number.isFinite(bx) && Number.isFinite(bw)) maxRight = Math.max(maxRight, bx + bw + 20);
          if (Number.isFinite(by) && Number.isFinite(bh)) maxBottom = Math.max(maxBottom, by + bh + 20);
        };
        bump(this._calibPortsBox);
        bump(this._calibUplinkBox);
      }
      W = Math.max(W, Math.ceil(maxRight));
      H = Math.max(H, Math.ceil(maxBottom));

      plate = useBg ? "" : `<rect x="10" y="10" width="${W - 20}" height="${H - 20}" rx="8"
        fill="var(--ha-card-background, var(--card-background-color, #1f2937))" stroke="var(--divider-color, #4b5563)"/>`;

      const _panelAuto = (Number(this._config.panel_width) <= 0);
      const _wrapStyles = [];
      if (useBg) _wrapStyles.push(`background-image:url(${bgUrl})`);
      // In auto mode, do NOT force an explicit pixel width on the panel wrapper.
      // We want it to naturally fill the available card width (responsive), matching fixed-width behavior.
      const _wrapStyleAttr = _wrapStyles.length ? ` style="${_wrapStyles.join(';')}"` : "";

      const svg = `
        <div class="panel-wrap${useBg ? " bg" : ""}"${_wrapStyleAttr}>
          <svg data-ssm-panel="1" viewBox="0 0 ${W} ${H}" width="100%" height="auto" preserveAspectRatio="xMidYMid meet">

            ${this._isCalibrationEnabled() ? `
              <!-- Background hit-target must be BEHIND ports so port dragging/selection works -->
              <rect id="ssm-calib-hit" x="0" y="0" width="${W}" height="${H}" fill="rgba(0,0,0,0.001)" style="pointer-events:all"></rect>
            ` : ``}

            ${plate}
            ${rects}
            <g id="ssm-label-layer" style="pointer-events:none">
              ${labels.join("")}
            </g>
            ${this._isCalibrationEnabled() ? `
              <g id="ssm-calib-layer" style="pointer-events:none"><rect id="ssm-calib-marquee" x="0" y="0" width="0" height="0" fill="rgba(0,150,255,.15)" stroke="rgba(0,150,255,.6)" stroke-width="1" style="display:none"></rect>
                <line id="ssm-calib-cross-v" x1="0" y1="0" x2="0" y2="${H}" stroke="rgba(255,255,255,.35)" stroke-width="1"></line>
                <line id="ssm-calib-cross-h" x1="0" y1="0" x2="${W}" y2="0" stroke="rgba(255,255,255,.35)" stroke-width="1"></line>
              </g>

              <g id="ssm-portsbox-layer" style="pointer-events:none">
                <rect id="ssm-portsbox-rect" x="0" y="0" width="0" height="0"
                  fill="rgba(0,150,255,0.08)" stroke="rgba(0,150,255,0.75)" stroke-width="2"
                  stroke-dasharray="6 4" rx="6" ry="6" style="display:none"></rect>
                <!-- 8 resize handles -->
                <rect class="ssm-portsbox-handle" data-h="nw" x="0" y="0" width="10" height="10" rx="2" ry="2" fill="rgba(0,150,255,0.85)" stroke="rgba(255,255,255,0.75)" stroke-width="1" style="display:none"></rect>
                <rect class="ssm-portsbox-handle" data-h="n"  x="0" y="0" width="10" height="10" rx="2" ry="2" fill="rgba(0,150,255,0.85)" stroke="rgba(255,255,255,0.75)" stroke-width="1" style="display:none"></rect>
                <rect class="ssm-portsbox-handle" data-h="ne" x="0" y="0" width="10" height="10" rx="2" ry="2" fill="rgba(0,150,255,0.85)" stroke="rgba(255,255,255,0.75)" stroke-width="1" style="display:none"></rect>
                <rect class="ssm-portsbox-handle" data-h="e"  x="0" y="0" width="10" height="10" rx="2" ry="2" fill="rgba(0,150,255,0.85)" stroke="rgba(255,255,255,0.75)" stroke-width="1" style="display:none"></rect>
                <rect class="ssm-portsbox-handle" data-h="se" x="0" y="0" width="10" height="10" rx="2" ry="2" fill="rgba(0,150,255,0.85)" stroke="rgba(255,255,255,0.75)" stroke-width="1" style="display:none"></rect>
                <rect class="ssm-portsbox-handle" data-h="s"  x="0" y="0" width="10" height="10" rx="2" ry="2" fill="rgba(0,150,255,0.85)" stroke="rgba(255,255,255,0.75)" stroke-width="1" style="display:none"></rect>
                <rect class="ssm-portsbox-handle" data-h="sw" x="0" y="0" width="10" height="10" rx="2" ry="2" fill="rgba(0,150,255,0.85)" stroke="rgba(255,255,255,0.75)" stroke-width="1" style="display:none"></rect>
                <rect class="ssm-portsbox-handle" data-h="w"  x="0" y="0" width="10" height="10" rx="2" ry="2" fill="rgba(0,150,255,0.85)" stroke="rgba(255,255,255,0.75)" stroke-width="1" style="display:none"></rect>
              </g>
            
              ${this._config.show_uplinks_separately ? `
              <g id="ssm-uplinkbox-layer" style="pointer-events:none">
                <rect id="ssm-uplinkbox-rect" x="0" y="0" width="0" height="0"
                  fill="rgba(0,150,255,0.10)" stroke="rgba(0,150,255,0.85)" stroke-width="2"
                  stroke-dasharray="6 4" rx="6" ry="6" style="display:none"></rect>
                <!-- 8 resize handles -->
                <rect class="ssm-uplinkbox-handle" data-h="nw" x="0" y="0" width="10" height="10" rx="2" ry="2" fill="rgba(0,150,255,0.95)" stroke="rgba(255,255,255,0.85)" stroke-width="1" style="display:none"></rect>
                <rect class="ssm-uplinkbox-handle" data-h="n"  x="0" y="0" width="10" height="10" rx="2" ry="2" fill="rgba(0,150,255,0.95)" stroke="rgba(255,255,255,0.85)" stroke-width="1" style="display:none"></rect>
                <rect class="ssm-uplinkbox-handle" data-h="ne" x="0" y="0" width="10" height="10" rx="2" ry="2" fill="rgba(0,150,255,0.95)" stroke="rgba(255,255,255,0.85)" stroke-width="1" style="display:none"></rect>
                <rect class="ssm-uplinkbox-handle" data-h="e"  x="0" y="0" width="10" height="10" rx="2" ry="2" fill="rgba(0,150,255,0.95)" stroke="rgba(255,255,255,0.85)" stroke-width="1" style="display:none"></rect>
                <rect class="ssm-uplinkbox-handle" data-h="se" x="0" y="0" width="10" height="10" rx="2" ry="2" fill="rgba(0,150,255,0.95)" stroke="rgba(255,255,255,0.85)" stroke-width="1" style="display:none"></rect>
                <rect class="ssm-uplinkbox-handle" data-h="s"  x="0" y="0" width="10" height="10" rx="2" ry="2" fill="rgba(0,150,255,0.95)" stroke="rgba(255,255,255,0.85)" stroke-width="1" style="display:none"></rect>
                <rect class="ssm-uplinkbox-handle" data-h="sw" x="0" y="0" width="10" height="10" rx="2" ry="2" fill="rgba(0,150,255,0.95)" stroke="rgba(255,255,255,0.85)" stroke-width="1" style="display:none"></rect>
                <rect class="ssm-uplinkbox-handle" data-h="w"  x="0" y="0" width="10" height="10" rx="2" ry="2" fill="rgba(0,150,255,0.95)" stroke="rgba(255,255,255,0.85)" stroke-width="1" style="display:none"></rect>
              </g>
              ` : ``}
` : ``}
          </svg>
        </div>`;

      return `
        ${this._config.info_position === "above" ? infoGrid : ""}
        <div class="panel">${svg}</div>
        ${this._isCalibrationEnabled() ? `
          <div class="calib-tools">
            <div class="calib-row">
              <div class="calib-title">Layout Editor</div>
              <div class="calib-status">
                Selected: <span id="ssm-calib-selected-count">0</span>
                • Cursor: <span id="ssm-calib-xy">-</span>
                <span id="ssm-calib-msg" class="calib-msg"></span>
              </div>
            </div>

            <div class="calib-hint">
              Drag ports to reposition • Ctrl-click to multi-select • Drag empty space to box-select.
              Use Align/Distribute for clean rows/columns. Click Save to persist locally.
            </div>

            <div class="calib-actions">
              <button class="iconbtn" id="ssm-calib-save" type="button" title="Save"><ha-icon icon="mdi:content-save"></ha-icon></button>
              <button class="iconbtn" id="ssm-calib-reset" type="button" title="Reset"><ha-icon icon="mdi:restore"></ha-icon></button>
<button class="iconbtn" id="ssm-calib-undo" type="button" title="Undo"><ha-icon icon="mdi:undo"></ha-icon></button>
              <button class="iconbtn" id="ssm-calib-redo" type="button" title="Redo"><ha-icon icon="mdi:redo"></ha-icon></button>

              <button class="iconbtn" id="ssm-calib-portsbox" type="button" title="Ports"><ha-icon icon="mdi:ethernet"></ha-icon></button>
              ${this._config.show_uplinks_separately ? `<button class="iconbtn" id="ssm-calib-uplinkbox" type="button" title="Uplinks"><ha-icon icon="mdi:arrow-up-bold"></ha-icon></button>` : ``}

<label class="calib-inline">
  Snap (px)
  <input id="ssm-calib-snap" class="calib-snap-input" type="number" inputmode="numeric" min="0" step="1" title="0 = Off" />
</label>

              <label class="calib-inline" id="ssm-calib-order-wrap" style="display:none">
                Order
                <select id="ssm-calib-order">
                  <option value="numeric">Numeric</option>
                  <option value="odd_even">Odd/Even</option>
                </select>
              </label>

              <button class="iconbtn" id="ssm-calib-align-row" type="button" title="Align row"><ha-icon icon="mdi:table-row"></ha-icon></button>
              <button class="iconbtn" id="ssm-calib-align-col" type="button" title="Align column"><ha-icon icon="mdi:table-column"></ha-icon></button>
              <button class="iconbtn" id="ssm-calib-dist-h" type="button" title="Distribute horizontally"><ha-icon icon="mdi:arrow-left-right-bold"></ha-icon></button>
              <button class="iconbtn" id="ssm-calib-dist-v" type="button" title="Distribute vertically"><ha-icon icon="mdi:arrow-up-down-bold"></ha-icon></button>

              <button class="iconbtn" id="ssm-calib-advanced-toggle" type="button" title="Advanced"><ha-icon icon="mdi:cog"></ha-icon></button>
              <button class="iconbtn" id="ssm-calib-close" type="button" title="Exit Layout Editor"><ha-icon icon="mdi:close"></ha-icon></button>
</div>

            <div id="ssm-calib-advanced" style="display:none">
              <div class="calib-hint" style="margin-top:8px">
                Advanced layout JSON (optional). Edit and click Apply to preview. Click Save to persist.
              </div>
              <textarea id="ssm-calib-json" rows="10" spellcheck="false"></textarea>
              <div id="ssm-calib-json-error" class="calib-hint" style="margin-top:6px; color: var(--error-color); display:none"></div>
              <div class="calib-actions" style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap">
                <button class="btn" id="ssm-calib-apply-json" type="button">Apply</button>
                <button class="btn" id="ssm-calib-format-json" type="button">Format</button>
                <button class="btn" id="ssm-calib-clear-json" type="button">Reset positions</button>
                <button class="btn" id="ssm-calib-copy-json" type="button">Copy JSON</button>
              </div>
            </div>
          </div>
        ` : ``}

        ${this._config.info_position === "below" ? infoGrid : ""}`;
    };

    const body = this._config.view === "panel" ? panelView() : listView();

    this.shadowRoot.innerHTML = `
      <ha-card>
        <style>${style}</style>
        ${header}
        ${body}
      </ha-card>
    `;


    // Ensure Home Assistant UI elements (ha-icon-button/ha-icon) render correctly
    // by passing the hass object into them.
    this.shadowRoot.querySelectorAll("ha-icon").forEach((el) => {
      try { el.hass = this._hass; } catch (e) {}
    });

    // wire list + virtual toggle buttons (keep click)
    this.shadowRoot.querySelectorAll(".btn[data-entity]").forEach(btn => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const id = ev.currentTarget.getAttribute("data-entity");
        if (id) this._toggle(id);
      });
    });

    // list + virtual name click: list opens the same modal as panel; virtual keeps alias prompt
    this.shadowRoot.querySelectorAll("[data-alias-entity]").forEach(el => {
      el.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const id = el.getAttribute("data-alias-entity");
        if (!id) return;
        if (el.classList.contains("name")) {
          if ((this._config?.color_mode || "state") === "speed" && this._config?.speed_click_opens_graph) {
          if (this._maybeOpenBandwidthGraphForPort(id)) return;
        }
        this._openDialog(id);
          return;
        }
        const st = this._hass?.states?.[id];
        const currentAlias = st?.attributes?.Alias;
        this._promptAlias(id, currentAlias);
      });
      el.addEventListener("keypress", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          const id = el.getAttribute("data-alias-entity");
          if (!id) return;
          if (el.classList.contains("name")) {
            if ((this._config?.color_mode || "state") === "speed" && this._config?.speed_click_opens_graph) {
          if (this._maybeOpenBandwidthGraphForPort(id)) return;
        }
        this._openDialog(id);
            return;
          }
          const st = this._hass?.states?.[id];
          const currentAlias = st?.attributes?.Alias;
          this._promptAlias(id, currentAlias);
        }
      });
    });

    // wire panel ports -> modal (pointerdown for reliability)
    this.shadowRoot.querySelectorAll(".port-svg[data-entity]").forEach(g => {
      g.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const id = g.getAttribute("data-entity");
        if (!id) return;
        if (this._isCalibrationEnabled()) return; // handled by calibration helper
        if ((this._config?.color_mode || "state") === "speed" && this._config?.speed_click_opens_graph) {
          if (this._maybeOpenBandwidthGraphForPort(id)) return;
        }
        this._openDialog(id);
      });
      g.addEventListener("keypress", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          const id = g.getAttribute("data-entity");
          if (!id) return;
          if (this._isCalibrationEnabled()) return; // handled by calibration helper
          this._openDialog(id);
        }
      });
    });

    // Calibration overlay/tools (panel view)
    this._setupCalibrationUI();

    // Re-attach modal AND style if they exist (so it stays styled and centered)
    if (this._modalStyle) this.shadowRoot.append(this._modalStyle);
    if (this._modalEl) this.shadowRoot.append(this._modalEl);

    this._reattachTransientModals();
  }
}

customElements.get("snmp-switch-manager-card") || customElements.define("snmp-switch-manager-card", SnmpSwitchManagerCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "snmp-switch-manager-card",
  name: "SNMP Switch Manager Card",
  description: "Auto-discovers SNMP Switch Manager ports with panel/list views, safe modal toggles, and diagnostics.",
  preview: true
});

// ------------------------------------------------------------
// Embedded GUI editor
//
// Home Assistant's Lovelace UI needs a config editor element to be registered
// *from the same Resource URL* as the card, so users only add a single
// dashboard resource (the HACS-installed one).
//
// NOTE: We keep this fully self-contained and guarded so that if a user still
// has the legacy editor resource installed, it won't break anything.
// ------------------------------------------------------------

// Only register the editor if it isn't already registered.
if (!customElements.get("snmp-switch-manager-card-editor")) {
  customElements.whenDefined("snmp-switch-manager-card").then(() => {
    const CardClass = customElements.get("snmp-switch-manager-card");

    // Tell Home Assistant how to get the editor + a stub config (guarded).
    if (!CardClass.getConfigElement) {
      CardClass.getConfigElement = () => {
        return document.createElement("snmp-switch-manager-card-editor");
      };
    }
    if (!CardClass.getStubConfig) {
      CardClass.getStubConfig = () => ({
        type: "custom:snmp-switch-manager-card",
        title: "SNMP Switch",
        view: "panel",
        color_mode: "state",
        ports_per_row: 24,
        panel_width: 740,
        port_size: 18,
        gap: 10,
        show_labels: true,
        label_numbers_only: false,
        label_size: 8,
        info_position: "above",
        hide_diagnostics: false,
        hide_virtual_interfaces: false,
        calibration_mode: false,
        device: null,
      });
    }

    class SnmpSwitchManagerCardEditor extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: "open" });
        this._config = {};
        this._hass = null;

        // Flags so we only render ONCE per editor instance
        this._hasConfig = false;
        this._hasHass = false;
        this._rendered = false;

        // Draft state to prevent config churn while typing (prevents focus loss)
        this._editingTitle = false;
        this._draftTitle = null;
        // Cache port entity ids per switch prefix (device) to avoid scanning all hass.states
        this._portEidsByPrefix = null;
        this._didVirtualMigrate = false;
      
        // Listen for saved calibration positions from the live card preview
        this._onSsmPositionsSaved = (ev) => {
          const d = ev && ev.detail ? ev.detail : null;
          if (!d || !d.port_positions || typeof d.port_positions !== "object") return;
          // Match by selected device prefix to avoid cross-talk
          if ((d.device || "") !== (this._config?.device || "")) return;
          this._updateConfig("port_positions", d.port_positions);
        };

        // Listen for "exit layout editor" from the live card preview so the toggle resets in the UI
        this._onSsmCalibrationClosed = (ev) => {
          const d = ev && ev.detail ? ev.detail : {};
          if (d.device && this._config?.device && (d.device || "") !== (this._config?.device || "")) return;
          if (!this._isCalibrationEnabled()) return;
          this._updateConfig("calibration_mode", false);
        };

      }

      // ---- Diagnostics auto-default helpers (Editor) ----
      // The live card injects conservative Environment/PoE defaults into the Diagnostics list
      // when the underlying sensors/attributes exist. The editor must mirror that logic so the
      // visual editor doesn't crash and the displayed Diagnostics order matches the live card.

      _inferDevicePrefix() {
        const cfg = this._config || {};
        if (cfg.device) return String(cfg.device);
        const ae = cfg.anchor_entity ? String(cfg.anchor_entity) : "";
        const ent = ae.includes(".") ? ae.split(".")[1] : "";
        const m = ent.match(/^(.+?)_(gi|fa|ge|te|tw|xe|et|eth|po|vlan|slot)\d/i);
        if (m) return m[1];
        return ent ? ent.split("_")[0] : "";
      }

      _autoDefaultDiagKeys(prefix, H) {
        // Prefer Sensors-mode entities when present; otherwise fall back to Attributes-mode
        // aggregate sensors (Environment + Power over Ethernet) and read specific attributes.
        const out = [];

        // Environment
        const envTemp = `sensor.${prefix}_system_temperature`;
        const envTempStatus = `sensor.${prefix}_system_temperature_status`;
        const envAgg = `sensor.${prefix}_environment`;
        if (H[envTemp]) out.push(envTemp);
        else {
          const st = H[envAgg];
          const v = st?.attributes?.["System Temperature (°C)"];
          if (v != null) out.push(`${envAgg}#System Temperature (°C)`);
        }
        if (H[envTempStatus]) out.push(envTempStatus);
        else {
          const st = H[envAgg];
          const v = st?.attributes?.["System Temperature Status"];
          if (v != null) out.push(`${envAgg}#System Temperature Status`);
        }

        // PoE
        const poeUsed = `sensor.${prefix}_poe_power_used`;
        const poeAvail = `sensor.${prefix}_poe_power_available`;
        const poeAgg = `sensor.${prefix}_power_over_ethernet`;
        if (H[poeUsed]) out.push(poeUsed);
        else {
          const st = H[poeAgg];
          const v = st?.attributes?.["PoE Power Used (W)"];
          if (v != null) out.push(`${poeAgg}#PoE Power Used (W)`);
          else if (st) out.push(poeAgg); // last resort: show aggregate sensor state
        }
        if (H[poeAvail]) out.push(poeAvail);
        else {
          const st = H[poeAgg];
          const v = st?.attributes?.["PoE Power Available (W)"];
          if (v != null) out.push(`${poeAgg}#PoE Power Available (W)`);
        }

        return out;
      }

      _isAutoDefaultDiagKey(key) {
        const k = String(key || "");
        return (
          /_system_temperature(_status)?$/.test(k) ||
          /_poe_power_(used|available)$/.test(k) ||
          /_environment#System Temperature/.test(k) ||
          /_power_over_ethernet#PoE Power (Used|Available)/.test(k) ||
          /_power_over_ethernet$/.test(k)
        );
      }

      _injectAutoDiagDefaults(order, enabledMap) {
        const H = this._hass?.states || {};
        const prefix = this._inferDevicePrefix();
        if (!prefix) return order;

        const defaults = this._autoDefaultDiagKeys(prefix, H);
        if (!defaults.length) return order;

        const out = Array.isArray(order) ? [...order] : [];
        for (const k of defaults) {
          if (enabledMap && enabledMap[k] === false) continue; // respect user removal/disable
          if (!out.includes(k)) out.push(k);
        }
        return out;
      }


      
      _setupAutoScale() {
        // Responsive scale for large displays (e.g., 4K). Defaults ON unless explicitly disabled.
        if (this._ssmResizeObs) return;
        const run = () => this._applyAutoScale();
        // Use ResizeObserver to react to layout changes without polling
        try {
          this._ssmResizeObs = new ResizeObserver(() => {
            if (this._ssmScaleRaf) cancelAnimationFrame(this._ssmScaleRaf);
            this._ssmScaleRaf = requestAnimationFrame(run);
          });
          this._ssmResizeObs.observe(this);
        } catch (e) {
          // Fallback: window resize
          window.addEventListener("resize", run);
          this._ssmResizeFallback = run;
        }
      }

      _applyAutoScale() {
        if (!this.shadowRoot) return;
        if (this._config && this._config.auto_scale === false) return;

        const outer = this.shadowRoot.querySelector(".autoscale-outer");
        const inner = this.shadowRoot.querySelector(".autoscale-inner");
        if (!outer || !inner) return;

        // Ensure we measure unscaled content
        inner.style.transform = "scale(1)";
        outer.style.height = "auto";

        const availW = outer.getBoundingClientRect().width;
        const contentW = inner.scrollWidth;
        const contentH = inner.scrollHeight;

        if (!availW || !contentW) return;

        // Allow upscaling on large displays; cap to avoid absurd zoom.
        const maxScale = 2.5;
        let s = availW / contentW;
        if (!Number.isFinite(s) || s <= 0) s = 1;
        if (s > maxScale) s = maxScale;

        inner.style.transform = `scale(${s})`;
        outer.style.height = `${Math.ceil(contentH * s)}px`;
      }
connectedCallback() {
        if (this._ssmPosListenerAdded) return;
        this._ssmPosListenerAdded = true;
        window.addEventListener("ssm-port-positions-saved", this._onSsmPositionsSaved);
        window.addEventListener("ssm-calibration-closed", this._onSsmCalibrationClosed);
        this._setupAutoScale();
      }

      disconnectedCallback() {
        if (!this._ssmPosListenerAdded) return;
        this._ssmPosListenerAdded = false;
        window.removeEventListener("ssm-port-positions-saved", this._onSsmPositionsSaved);
        window.removeEventListener("ssm-calibration-closed", this._onSsmCalibrationClosed);
        if (this._ssmResizeObs) {
          try { this._ssmResizeObs.disconnect(); } catch (e) {}
          this._ssmResizeObs = null;
        }
      }

      _defaultSpeedPalette() {
        return {
          "10 Mbps": "#9ca3af",
          "100 Mbps": "#f59e0b",
          "1 Gbps": "#22c55e",
          "2.5 Gbps": "#14b8a6",
          "5 Gbps": "#0ea5e9",
          "10 Gbps": "#3b82f6",
          "20 Gbps": "#6366f1",
          "25 Gbps": "#8b5cf6",
          "40 Gbps": "#a855f7",
          "50 Gbps": "#d946ef",
          "100 Gbps": "#ec4899",
          "Unknown": "#ef4444",
        };
      }



      _stateLabel(key) {
        switch (key) {
          case "up_up": return "Up/Up";
          case "up_down": return "Up/Down";
          case "down_down": return "Admin Down";
          case "up_not_present": return "Not Present";
          default: return key;
        }
      }

      _diagnosticLabel(key) {
      const k = String(key || "");
      const map = {
        hostname: "Hostname",
        manufacturer: "Manufacturer",
        model: "Model",
        firmware: "Firmware Revision",
        firmware_revision: "Firmware Revision",
        uptime: "Uptime",
      };
      if (map[k]) return map[k];
      if (this._hass && this._hass.states && this._hass.states[k]) {
        return this._hass.states[k].attributes.friendly_name || k;
      }
      return k;
    }


      _defaultStatePalette() {
        // Defaults match the card's current state mode legend.
        // Keys are internal and stable; UI can present friendly labels.
        return {
          "up_up": "#22c55e",           // Green — Admin: Up • Oper: Up
          "up_down": "#ef4444",         // Red — Admin: Up • Oper: Down
          "down_down": "#f59e0b",       // Orange — Admin: Down • Oper: Down
          "up_not_present": "#9ca3af",  // Gray — Admin: Up • Oper: Not Present
        };
      }


      _speedLabelFromAttrs(attrs) {
        if (!attrs) return null;
        const candidates = [
          attrs.SpeedLabel, attrs.speed_label, attrs.speedLabel, attrs.speedText, attrs.speed_text, attrs.SpeedDisplay, attrs.speed_display, attrs.speedDisplay,
          attrs.LinkSpeedLabel, attrs.link_speed_label, attrs.LinkSpeedText, attrs.link_speed_text,
          attrs.PortSpeedLabel, attrs.port_speed_label,
          attrs.Speed, attrs.speed, attrs.PortSpeed, attrs.port_speed, attrs.link_speed, attrs.LinkSpeed,
          attrs.ifSpeed, attrs.if_speed
        ].filter(v => v != null);

        for (const raw of candidates) {
          if (typeof raw !== "string") continue;
          const s0 = raw.trim();
          if (!s0) continue;
          const s = s0.replace(/\s+/g, " ").trim();
          const compact = s.toLowerCase().replace(/\s+/g, "");
          const m = compact.match(/^([0-9]+(?:\.[0-9]+)?)(m|g)bps$/);
          if (m) return `${m[1]} ${(m[2] === "g") ? "Gbps" : "Mbps"}`;
          if (/^[0-9]+(?:\.[0-9]+)?\s*(m|g)bps$/i.test(s)) {
            const mm = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*(m|g)bps$/i);
            return `${mm[1]} ${(mm[2].toLowerCase() === "g") ? "Gbps" : "Mbps"}`;
          }
        }
        return null;
      }


_allSupportedSpeedLabels() {
  const palette = this._defaultSpeedPalette();
  const labels = new Set(Object.keys(palette || {}));
  labels.add("Disconnected");
  labels.add("Admin Down");

  // Sort ascending by Mbps
  const toMbps = (lab) => {
    if (typeof lab === "number") return lab;
    if (lab === "Admin Down") return -2;
    if (lab === "Admin Down") return -2;
    if (lab === "Disconnected") return -1;
    const s = String(lab);
    const m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*(M|G)bps$/i);
    if (!m) return Number.POSITIVE_INFINITY;
    const v = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    return unit === "g" ? v * 1000 : v;
  };

  return Array.from(labels).sort((a, b) => toMbps(a) - toMbps(b));
}

_detectedSpeedLabels(devicePrefix) {
  const hass = this._hass;
  const labels = new Set();

  const map = (this._portEidsByPrefix instanceof Map) ? this._portEidsByPrefix : null;
  if (!map || !hass?.states) return [];

  const prefix = String(devicePrefix || "");
  const wantAll = !prefix || prefix === "all";

  const addFromList = (list) => {
    if (!Array.isArray(list) || !list.length) return;
    for (const eid of list) {
      const st = hass.states[eid];
      if (!st) continue;
      const label = this._speedLabelFromAttrs(st?.attributes) || null;
      if (label) labels.add(label);
    }
  };

  if (wantAll) {
    for (const list of map.values()) addFromList(list);
  } else {
    addFromList(map.get(prefix) || null);
  }

  // Sort ascending by Mbps
  const toMbps = (lab) => {
    if (typeof lab === "number") return lab;
    if (lab === "Disconnected") return -1;
    const s = String(lab);
    const m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*(M|G)bps$/i);
    if (!m) return Number.POSITIVE_INFINITY;
    const v = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    return unit === "g" ? v * 1000 : v;
  };
    labels.add("Disconnected");
  labels.add("Admin Down");
  return Array.from(labels).sort((a, b) => toMbps(a) - toMbps(b));
}

  _renderStateColorsSection(c) {
        const palette = this._defaultStatePalette();
        const overrides = (c.state_colors && typeof c.state_colors === "object") ? c.state_colors : {};
        const keys = ["up_up", "up_down", "down_down", "up_not_present"];

        const items = keys.map((k) => {
          const val = (typeof overrides[k] === "string" && overrides[k].trim())
            ? overrides[k].trim()
            : (palette[k] || "#9ca3af");
          return `
            <div class="colorItem">
              <div class="colorTitle">${this._escape(this._stateLabel(k))}</div>
              <div class="colorControls">
                <input class="statecolor" type="color" data-state="${this._escape(k)}" value="${this._escape(val)}" />
                <input class="statehex" type="text" maxlength="7" data-state="${this._escape(k)}" value="${this._escape(val)}" />
              </div>
            </div>
          `;
        }).join("");

        const hasOverrides = c.state_colors && typeof c.state_colors === "object" && Object.keys(c.state_colors).length > 0;

        return `
          <div class="row">
            <div class="rowhead">
              <label>State colors</label>
              <button id="state_reset" class="iconbtn sm" type="button" title="Reset to defaults"${hasOverrides ? "" : " disabled"}>
                <ha-icon icon="mdi:restore"></ha-icon>
              </button>
            </div>
            <div class="hint">Customize the colors used when Color mode is set to State.</div>
            <div class="colorGrid">${items}</div>
          </div>
        `;
      }




      _renderSpeedColorsSection(c) {
        const palette = this._defaultSpeedPalette();
        const overrides = (c.speed_colors && typeof c.speed_colors === "object") ? c.speed_colors : {};
        const labels = (c.show_all_speeds === true) ? this._allSupportedSpeedLabels() : this._detectedSpeedLabels(c.device);

        const items = labels.map((lab) => {
          const o = (typeof overrides[lab] === "string" && overrides[lab].trim())
            ? overrides[lab].trim()
            : null;
          const o2 = (lab === "Disconnected" && typeof overrides["Unknown"] === "string" && overrides["Unknown"].trim())
            ? overrides["Unknown"].trim()
            : null;
          const val = o || o2 || (palette[lab] || palette["Disconnected"] || palette["Unknown"] || "#ef4444");
          return `
            <div class="colorItem">
              <div class="colorTitle">${this._escape(lab)}</div>
              <div class="colorControls">
                <input class="speedcolor" type="color" data-speed="${this._escape(lab)}" value="${this._escape(val)}" />
                <input class="speedhex" type="text" maxlength="7" data-speed="${this._escape(lab)}" value="${this._escape(val)}" />
              </div>
            </div>
          `;
        }).join("");

        const hasOverrides = c.speed_colors && typeof c.speed_colors === "object" && Object.keys(c.speed_colors).length > 0;

        return `
          <div class="row">
            <div class="rowhead">
              <label>Speed colors</label>
              <button id="speed_reset" class="iconbtn sm" type="button" title="Reset to defaults"${hasOverrides ? "" : " disabled"}>
                <ha-icon icon="mdi:restore"></ha-icon>
              </button>
            </div>
            
            <div class="row inline" style="align-items:center;gap:10px;margin-top:8px;">
              <label for="show_all_speeds" style="margin:0;">Show all speeds</label>
              <ha-switch id="show_all_speeds"${c.show_all_speeds ? " checked" : ""}></ha-switch>
            </div>
            <div class="hint">Colors are based on the switch's normalized speed labels. When "Show all speeds" is on, the full supported set is shown even if the device hasn’t reported that speed yet.</div>
            <div class="colorGrid">${items}</div>
          </div>
        `;
      }



      set hass(c) {
        const palette = this._defaultSpeedPalette();
        const overrides = (c.speed_colors && typeof c.speed_colors === "object") ? c.speed_colors : {};
        const labels = this._detectedSpeedLabels(c.device);
        const rows = labels.map((lab) => {
          const val = (typeof overrides[lab] === "string" && overrides[lab].trim())
            ? overrides[lab].trim()
            : (palette[lab] || palette["Disconnected"]);
          return `
            <div class="speedrow">
              <div class="speedlabel">${this._escape(lab)}</div>
              <input class="speedcolor" type="color" data-speed="${this._escape(lab)}" value="${this._escape(val)}" />
              <input class="speedhex" type="text" data-speed="${this._escape(lab)}" value="${this._escape(val)}" />
            </div>
          `;
        }).join("");

        const hasOverrides = c.speed_colors && typeof c.speed_colors === "object" && Object.keys(c.speed_colors).length > 0;

        return `
          <div class="row">
            <label>Speed colors</label>
            <div class="hint">Colors are based on the switch's normalized speed labels. Only speeds detected on the selected device are shown (or across all devices when none is selected).</div>
            <div class="speedgrid">${rows}</div>
            <div class="row inline">
              <button id="speed_reset" class="btn" type="button"${hasOverrides ? "" : " disabled"}>Reset to defaults</button>
            </div>
          </div>
        `;
      }

      set hass(hass) {
        // Keep hass (editor API) but **do not** re-render on every state change.
        // HA updates hass very frequently; rebuilding the editor DOM causes inputs / datalist
        // selections to disappear mid-typing (the "refresh" issue).
        const first = !this._hasHass;
        this._hass = hass;
        this._hasHass = true;

        if (first) {
          this._loadSnmpDevices();
        }

        if (!this._hasConfig) return;

        // Only re-render when the *available ports list* changes for the selected device.
        // This keeps the datalist current without nuking the UI on unrelated state updates.
        const dev = (this._config?.device || "").toString();
        const ports = dev ? (this._getPortsForDevice(dev) || []) : [];
        const sig = dev + "::" + ports.join("|");
        if (sig !== this._lastPortsSig) {
          this._lastPortsSig = sig;
          this._render();
        }
      }

      setConfig(config) {
        config = _ssmNormalizeConfig(config);

        this._config = { ...config };

        // Hydrate Layout positions from localStorage so they persist when the user clicks Save in the HA editor.
        // This is critical because Layout Editor changes can happen outside the HA config dialog.
        try {
          const prefix = (this._config?.device || "") ? String(this._config.device) : "";
          const bg = String(this._config?.background_image || "");
          const key = `ssm_calib_v2:${prefix || "unknown"}:${bg}`;
          const raw = localStorage.getItem(key);
          if (raw) {
            const obj = JSON.parse(raw);
            const map = (obj && typeof obj === "object" && obj.map && typeof obj.map === "object")
              ? obj.map
              : (obj && typeof obj === "object" ? obj : null);
            if (map && typeof map === "object") {
              this._config.port_positions = map;
            }
          }
        } catch (e) {}

        // If the user closed the Layout Editor from the live card, reset the toggle here so it persists.
// IMPORTANT: do NOT clear the flag until the config actually has calibration_mode=false saved,
// otherwise "Cancel" in the HA editor would resurrect the old YAML value.
try {
  const prefix = (this._config?.device || "") ? String(this._config.device) : "all";
  const k = `ssm_calib_force_off:${prefix}`;
  const ts = localStorage.getItem(k);

  // If we already see calibration_mode=false coming from YAML, clear the one-shot flag.
  if (ts && !this._config?.calibration_mode) {
    localStorage.removeItem(k);
  }

  // If YAML still says true, force it off in the editor view (and keep the flag)
  // so it stays off across cancel/re-open until the user saves.
  if (ts && this._config?.calibration_mode) {
    setTimeout(() => {
      try { this._updateConfig("calibration_mode", false); } catch (e) {}
    }, 0);
  }
} catch (e) {}

        if (!this._editingTitle) {
          this._draftTitle = null;
        }

        this._hasConfig = true;
        // Re-render when config changes so lists + preview stay in sync.
        if (this._hasHass) {
          this._render();
        }
      }

      // ---- helpers ----

async _loadSnmpDevices() {
  if (this._loadingDevices) return;
  if (!this._hass) return;

  // Cache once per editor instance; keep it simple & robust.
  if (Array.isArray(this._snmpDevices)) return;

  this._loadingDevices = true;
  try {
    // 1) Find SNMP Switch Manager config entry ids
    const entries = await this._hass.callWS({ type: "config_entries/get" });
    const entryIds = (entries || [])
      .filter(e => e && e.domain === "snmp_switch_manager")
      .map(e => e.entry_id);

    // 2) List devices and filter to those attached to the SNMP Switch Manager entries
    const devices = await this._hass.callWS({ type: "config/device_registry/list" });
    const snmpDevices = (devices || []).filter(d =>
      Array.isArray(d?.config_entries) && d.config_entries.some(id => entryIds.includes(id))
    );

    // 3) Map device -> hostname prefix by looking at entity registry entries attached to that device
    //    (We only need a stable prefix so the card can scope ports/sensors by entity_id.)
    const entityReg = await this._hass.callWS({ type: "config/entity_registry/list" });
    const byDevice = new Map();
    for (const ent of (entityReg || [])) {
      const did = ent?.device_id;
      const eid = ent?.entity_id;
      if (!did || !eid) continue;
      if (!byDevice.has(did)) byDevice.set(did, []);
      byDevice.get(did).push(eid);
    }

    const result = [];
    const portEidsByPrefix = new Map();
    for (const d of snmpDevices) {
      const id = d.id;
      const name = d.name_by_user || d.name || id;

      // Prefer a hostname sensor if present; else fall back to a switch entity.
      const eids = byDevice.get(id) || [];
      let prefix = "";
      for (const eid of eids) {
        const m = String(eid).match(/^sensor\.([a-z0-9_]+)_hostname$/i);
        if (m) { prefix = m[1]; break; }
      }
      if (!prefix) {
        for (const eid of eids) {
          const m = String(eid).match(/^switch\.([a-z0-9_]+)_/i);
          if (m) { prefix = m[1]; break; }
        }
      }

      // If we can't derive a prefix, skip it (prevents "empty selection" that breaks scoping).
      if (!prefix) continue;

      const portEids = eids.filter(eid => String(eid).startsWith(`switch.${prefix}_`));
      portEidsByPrefix.set(prefix, portEids);
      result.push({ id, name, prefix, portEids });
    }

    result.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    this._snmpDevices = result;
    this._portEidsByPrefix = portEidsByPrefix;
  } catch (err) {
    // If anything fails, keep an empty list (but do not break the card/editor).
    // eslint-disable-next-line no-console
    console.warn("SNMP Switch Manager Card: failed to load devices", err);
    this._snmpDevices = [];
    this._portEidsByPrefix = new Map();
  } finally {
    this._loadingDevices = false;
    // Re-render once after devices load; do not flip _rendered back to false.
    this._render();
  }
}

_listDevicesFromHass() {
  // Back-compat fallback: return any cached SNMP devices prefixes.
  const list = Array.isArray(this._snmpDevices) ? this._snmpDevices : [];
  return list.map(d => d.prefix);
}

      _escape(str) {
        if (str == null) return "";
        return String(str)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\"/g, "&quot;");
      }        // Restore focus after re-render (best-effort).
        if (_activeId) {
          const el = this.shadowRoot.getElementById(_activeId);
          if (el && typeof el.focus === "function") {
            el.focus();
            if (_activeSel && typeof el.setSelectionRange === "function") {
              try { el.setSelectionRange(_activeSel.start, _activeSel.end); } catch(e) {}
            }
          }
        }


      _updateConfig(key, value) {
        if (!this._config) this._config = {};
        const newConfig = { ...this._config, [key]: value };
        this._config = newConfig;
        this.dispatchEvent(
          new CustomEvent("config-changed", {
            detail: { config: newConfig },
            bubbles: true,
            composed: true,
          }),
        );
        // IMPORTANT: no re-render here – we keep the DOM as-is
      }

      _portsForPrefix(prefix) {
        const hass = this._hass;
        const pfx = String(prefix || "").trim();
        if (!hass || !pfx) return [];
        const pre = `switch.${pfx.toLowerCase()}_`;
        const out = [];
        // Scan only entities matching the selected device prefix (bounded, low risk)
        for (const [eid, st] of Object.entries(hass.states || {})) {
          if (!eid || typeof eid !== "string") continue;
          if (!eid.toLowerCase().startsWith(pre)) continue;
          const a = st && st.attributes ? st.attributes : {};
          const name = String(a.Name || "").trim();
          if (!name) continue;
          out.push({ name, entity_id: eid });
        }
        // Sort naturally by last number when possible
        out.sort((aa, bb) => {
          const a = aa.name, b = bb.name;
          const ma = a.match(/(\d+)(?!.*\d)/), mb = b.match(/(\d+)(?!.*\d)/);
          const na = ma ? parseInt(ma[1], 10) : NaN;
          const nb = mb ? parseInt(mb[1], 10) : NaN;
          if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
          return a.localeCompare(b);
        });
        return out;
      }

      _deviceHasBandwidthSensors(prefix) {
        const hass = this._hass;
        const pfx = String(prefix || "").trim().toLowerCase();
        if (!hass || !pfx) return false;

        // Bandwidth sensor entity_ids are derived from the device prefix, but may not
        // share the same base as the per-port switch entity_id on all vendors.
        // We consider bandwidth "available" if we can find any RX/TX throughput pair
        // for this device prefix.
        const rxSuffix = "_rx_throughput";
        const states = hass.states || {};
        for (const eid of Object.keys(states)) {
          if (!eid || typeof eid !== "string") continue;
          const e = eid.toLowerCase();
          if (!e.startsWith(`sensor.${pfx}_`)) continue;
          if (!e.endsWith(rxSuffix)) continue;

          const tx = eid.slice(0, -rxSuffix.length) + "_tx_throughput";
          if (states[tx]) return true;
        }
        return false;
      }




      _render() {
        if (!this.shadowRoot) return;
        // Preserve focused field across re-renders (prevents losing focus while editing)
        const _active = this.shadowRoot.activeElement;
        const _activeId = _active && _active.id ? _active.id : null;
        const _activeSel = (_active && typeof _active.selectionStart === 'number') ? { start: _active.selectionStart, end: _active.selectionEnd } : null;
        let c = this._config || {};
        const devices = Array.isArray(this._snmpDevices) ? this._snmpDevices : [];
        const deviceOptions = devices.map(d => {
          const sel = String(c.device || "") === String(d.prefix) ? " selected" : "";
          return `<option value="${this._escape(d.prefix)}"${sel}>${this._escape(d.name)}</option>`;
        }).join("");

        const portChoices = this._portsForPrefix(String(c.device || ""));
        const _hasBandwidth = (c.color_mode === "speed") && this._deviceHasBandwidthSensors(String(c.device || ""));

        const portNameChoices = portChoices.map(p => String(p.name || "").trim()).filter(Boolean);
        portNameChoices.sort(_ssmNaturalPortCompare);
        // One-time migration: legacy physical rules -> virtual_overrides (inverted)
        // This runs only when the editor has discovered the port list for the selected device.
        try {
          if (!this._didVirtualMigrate) {
            const hasLegacyPref = String(c.physical_prefixes || "").trim();
            const hasLegacyRx = String(c.physical_regex || "").trim();
            const hasLegacy = !!(hasLegacyPref || hasLegacyRx);
            const hasVirtualOverrides = Array.isArray(c.virtual_overrides)
              ? c.virtual_overrides.length > 0
              : (typeof c.virtual_overrides === "string" && c.virtual_overrides.trim());
            if (hasLegacy && !hasVirtualOverrides && portChoices.length) {
              const rxStr = hasLegacyRx;
              const prefStr = hasLegacyPref;
              const prefs = prefStr ? prefStr.split(",").map(s=>s.trim()).filter(Boolean) : [];
              let rx = null;
              if (rxStr) {
                try { rx = new RegExp(rxStr, "i"); } catch(e) { rx = null; }
              }
              const virtualNames = [];
              for (const p of portChoices) {
                const n = String(p.name || "").trim();
                const id = String(p.entity_id || "").trim();
                if (!n && !id) continue;
                let isPhysical = false;
                if (rx) isPhysical = rx.test(n) || rx.test(id);
                if (!isPhysical && !rx && prefs.length) {
                  const nUp = n.toUpperCase();
                  isPhysical = prefs.some(pp => nUp.startsWith(String(pp).trim().toUpperCase()));
                }
                // If legacy rules match physical, virtual is the inverse.
                if (!isPhysical && n) virtualNames.push(n);
              }
              // De-dupe (case-insensitive) while preserving order
              const seen = new Set();
              const virtDedup = [];
              for (const v of virtualNames) {
                const k = String(v).toLowerCase();
                if (seen.has(k)) continue;
                seen.add(k);
                virtDedup.push(v);
              }
              const newConfig = { ...this._config, virtual_overrides: virtDedup };
              // Remove legacy keys from config so they don't keep surfacing in UI/logic
              delete newConfig.physical_prefixes;
              delete newConfig.physical_regex;
              this._config = newConfig;
              this._didVirtualMigrate = true;
              this.dispatchEvent(new CustomEvent("config-changed", {
                detail: { config: newConfig },
                bubbles: true,
                composed: true,
              }));
              // Continue render using migrated config
              c = newConfig;
            }
          }
        } catch(e) {}

        const normLower = (arr) => {
          const out = [];
          const seen = new Set();
          (arr || []).forEach(v => {
            const s = String(v || "").trim();
            if (!s) return;
            const k = s.toLowerCase();
            if (seen.has(k)) return;
            seen.add(k);
            out.push(s);
          });
          return out;
        };
        const _alphaSort = (arr) => (arr || []).slice().sort(_ssmNaturalPortCompare);
        const hidePortsArr = _alphaSort(normLower(c.hide_ports));
        const uplinkPortsArr = _alphaSort(normLower(c.uplink_ports));
        const virtualOverridesArr = _alphaSort(normLower(c.virtual_overrides));

        const portDatalistHtml = portNameChoices.length
          ? portNameChoices.slice().sort((a,b)=>_ssmNaturalPortCompare(a,b)).map(n => `<option value="${this._escape(n)}"></option>`).join("")
          : "";

        const renderSelectList = (arr, kind) => {
          if (!arr.length) return ``;
    const sorted = [...arr].sort((a, b) => _ssmNaturalPortCompare(a, b));
  // Render as HA-style selectable list rows (not chips) for consistency with current HA editors.
  // We still use data-chip-* attrs so existing remove handlers keep working.
  return `<div class="halist" id="${kind}_list">` + sorted.map(v =>
    `<div class="halist-row">
      <div class="halist-main">
        <div class="halist-title">${this._escape(v)}</div>
      </div>
      <button type="button" class="halist-remove chip" data-chip-kind="${kind}" data-chip-val="${this._escape(v)}" title="Remove">×</button>
    </div>`
  ).join("") + `</div>`;
};

        const hidePortsHtml = `
          ${renderSelectList(hidePortsArr, "hide_ports")}
          <div class="chipadd">
            <input id="hide_ports_add" class="chipinput" type="text" list="ssm_ports_datalist" placeholder="Add port…">
            <button type="button" class="chipbtn" id="hide_ports_add_btn">Add</button>
          </div>
        `;

        const uplinkPortsHtml = `
          ${renderSelectList(uplinkPortsArr, "uplink_ports")}
          <div class="chipadd">
            <input id="uplink_ports_add" class="chipinput" type="text" list="ssm_ports_datalist" placeholder="Add uplink port…">
            <button type="button" class="chipbtn" id="uplink_ports_add_btn">Add</button>
          </div>
        `;

        const virtualOverridesHtml = `
          ${renderSelectList(virtualOverridesArr, "virtual_overrides")}
          <div class="chipadd">
            <input id="virtual_overrides_add" class="chipinput" type="text" list="ssm_ports_datalist" placeholder="Add virtual interface…">
            <button type="button" class="chipbtn" id="virtual_overrides_add_btn">Add</button>
          </div>
        `;

        const stateColorsHtml = (c.color_mode === "speed") ? "" : this._renderStateColorsSection(c);
        const speedColorsHtml = (c.color_mode === "speed") ? this._renderSpeedColorsSection(c) : "";

        this.shadowRoot.innerHTML = `
          <style>
            .form{display:flex;flex-direction:column;gap:12px;padding:8px 4px 12px;}
            details.section{border:1px solid var(--divider-color);border-radius:14px;background:var(--card-background-color);overflow:hidden;}
            details.section + details.section{margin-top:12px;}
            details.section > summary{list-style:none;cursor:pointer;padding:12px 14px;font-size:14px;font-weight:600;display:flex;align-items:center;justify-content:space-between;}
            details.section > summary::-webkit-details-marker{display:none;}
details.section > summary::after{
              content:"▾";
              font-size:18px;
              opacity:0.75;
              transition: transform .18s ease;
            }
            details.section[open] > summary::after{
              transform: rotate(180deg);
            }
            details.section[open] > summary{border-bottom:1px solid var(--divider-color);}
            .secbody{padding:12px 14px;display:flex;flex-direction:column;gap:12px;}
            .row{display:flex;flex-direction:column;gap:4px;}
            .row.inline{flex-direction:row;align-items:center;justify-content:space-between;gap:10px;}
            .row.two{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:end;}
            /* Dark dropdowns (fix white background in HA dialogs) */
            select, option {
              color: var(--primary-text-color);
            }
            select {
              background: var(--card-background-color);
              border: 1px solid var(--divider-color);
              border-radius: 10px;
              padding: 10px 12px;
              color-scheme: dark;
            }
            option { background: var(--card-background-color); }
            
            .diaglist{display:flex;flex-direction:column;gap:8px;}
            .diagitem{display:flex;align-items:center;justify-content:space-between;gap:10px;
              padding:10px 12px;border:1px solid var(--divider-color);border-radius:12px;
              background:rgba(0,0,0,0.10);cursor:pointer;}
            .diagitem.disabled{opacity:0.55;}
            .diagname{font-weight:600; overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
            .diagactions{display:flex;align-items:center;gap:8px;}
            .btn.icon{width:34px; padding:0; text-align:center;}
            .sub{font-size:12px; opacity:0.85;}

            /* Compact color grids */
            .colorGrid{
              display:grid;
              grid-template-columns: repeat(auto-fill, minmax(95px, 1fr));
              gap:10px;
              align-items:start;
            }
            .colorItem{
              display:flex;
              flex-direction:column;
              gap:6px;
              padding:8px;
              border:1px solid var(--divider-color);
              border-radius:12px;
              background:rgba(0,0,0,0.06);
            }
            .colorControls{display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;gap:8px;}
            .colorTitle{
              font-size:12px;
              font-weight:600;
              opacity:0.95;
              text-align:left;
              white-space:nowrap;
              overflow:hidden;
              text-overflow:ellipsis;
            }
            .statecolor,.speedcolor{width:34px;height:34px;padding:0;border:none;background:transparent;border-radius:8px;margin:0 auto;display:block;}
            .statehex,.speedhex{width:100%;max-width:none;font-family:var(--code-font-family, monospace);padding:6px 8px;border-radius:10px;border:1px solid var(--divider-color);background:var(--card-background-color);color:var(--primary-text-color);text-align:center;box-sizing:border-box;}

            .hint{display:none;}
            .subhead-row{display:flex; align-items:center; justify-content:space-between; gap:10px;}
      .rowhead{position:relative;display:flex;align-items:center;justify-content:space-between;gap:8px;}
      .rowhead label{margin:0;}
      .helpiconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:999px;background:transparent;border:1px solid var(--divider-color);color:var(--secondary-text-color);cursor:pointer;flex:0 0 auto;}
      /* Nudge the icon up slightly so it visually aligns with the label baseline */
      .rowhead .helpiconbtn{transform:translateY(-1px);}
.helpiconbtn:hover{background:rgba(0,0,0,0.18);} 
.helpiconbtn:active{background:rgba(0,0,0,0.26);} 
.helpiconbtn:focus{outline:2px solid var(--primary-color);outline-offset:2px;}
.helpiconbtn ha-icon{--mdc-icon-size:18px;}

.ssm-help-popover{position:fixed; z-index:99999; max-width:340px; padding:10px 12px; border-radius:12px; border:1px solid var(--divider-color); background:var(--card-background-color); color:var(--primary-text-color); box-shadow:0 10px 30px rgba(0,0,0,.45); font-size:13px; line-height:1.35;}
      .ssm-help-popover .close:hover{background:rgba(0,0,0,0.15);} 
.helpline{display:flex;justify-content:flex-end;margin-top:6px;}
            label{font-size:13px;font-weight:500;}
            input[type="text"],input[type="number"],select,textarea{width:100%;box-sizing:border-box;padding:9px 10px;border-radius:10px;border:1px solid var(--divider-color);background:var(--card-background-color);color:var(--primary-text-color);}input[type="text"]:focus,input[type="number"]:focus,select:focus,textarea:focus{outline:2px solid var(--primary-color);outline-offset:2px;}
            textarea{min-height:72px;resize:vertical;}
            .inline{display:flex;gap:8px;align-items:center;}
            .btn{padding:8px 12px;border-radius:10px;border:1px solid var(--divider-color);background:var(--card-background-color);cursor:pointer;}
            .iconbtn{width:36px;height:36px;border-radius:10px;border:1px solid var(--divider-color);background:var(--card-background-color);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;}
            .iconbtn.sm{width:32px;height:32px;border-radius:10px;}
            .iconbtn ha-icon{--mdc-icon-size:18px;}
            .iconbtn:disabled{opacity:0.5;cursor:default;}

            .btn.sm{padding:4px 10px;border-radius:10px;font-size:12px;}
            .divider{border-top:1px solid var(--divider-color);margin:8px 0;}
            /* searchable checklist */
            .pickwrap{display:flex;flex-direction:column;gap:8px;}
            .picksearch{width:100%;}
            .picklist{border:1px solid var(--divider-color);border-radius:10px;padding:8px;max-height:220px;overflow:auto;display:flex;flex-direction:column;gap:6px;background:rgba(0,0,0,0.02);}
            .chk{display:flex;gap:8px;align-items:center;font-size:13px;}

            /* HA-style selectable lists (used for Hide ports / Uplink ports / Physical prefixes) */
.halist{border:1px solid var(--divider-color);border-radius:14px;overflow:hidden;background:rgba(0,0,0,0.03);}
.halist-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--divider-color);}
.halist-row:last-child{border-bottom:none;}
.halist-main{flex:1;min-width:0;}
.halist-title{font-size:14px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.halist-remove{width:34px;height:34px;border-radius:10px;border:1px solid var(--divider-color);background:rgba(0,0,0,0.02);color:var(--primary-text-color);cursor:pointer;font-size:18px;line-height:1;display:flex;align-items:center;justify-content:center;}
.halist-remove:hover{background:rgba(0,0,0,0.06);}

/* add row under lists */
.chipadd{margin-top:10px;display:flex;gap:10px;align-items:center;}
.chipinput{flex:1;min-width:0;padding:9px 10px;border-radius:10px;border:1px solid var(--divider-color);background:rgba(0,0,0,0.02);color:var(--primary-text-color);}
.chipbtn{padding:9px 12px;border-radius:10px;border:1px solid var(--divider-color);background:rgba(0,0,0,0.02);color:var(--primary-text-color);cursor:pointer;}
.chipbtn:hover{background:rgba(0,0,0,0.06);}
            .chip .x{font-size:14px;line-height:1;opacity:.75;margin-left:2px;}
            .chipadd{display:flex;gap:8px;align-items:center;margin-top:8px;}
            .chipinput{flex:1;min-width:120px;}
            .chipbtn{border:1px solid var(--divider-color);border-radius:10px;padding:6px 10px;background:var(--card-background-color);cursor:pointer;}
            .chipbtn:hover{background:rgba(0,0,0,0.04);}
            .diaglist{display:flex;flex-direction:column;gap:6px;width:100%;}
            .diagitem{display:flex;align-items:center;justify-content:space-between;border:1px solid var(--divider-color);border-radius:10px;padding:6px 8px;}
            .diagbtns{display:flex;gap:6px;}
            .diagbtns button{cursor:pointer;padding:2px 8px;border:1px solid var(--divider-color);border-radius:10px;background:var(--card-background-color);color:var(--primary-text-color);}
          </style>

          <div class="form">

            <datalist id="ssm_ports_datalist">
              ${portDatalistHtml}
            </datalist>

            <details class="section" open>
              <summary>Switch</summary>
              <div class="secbody">
                <div class="row">
                  <label for="title">Title</label>
                  <input id="title" type="text" value="${this._escape(((this._draftTitle ?? c.title) || ""))}">
                </div>

                <div class="row">
                  <label for="device">Switch device</label>
                  <select id="device">
                    <option value="">Select a device…</option>
                    ${deviceOptions}
                  </select>
                  <div class="hint">Select a SNMP Switch Manager device (derived from entity ID prefixes).</div>
                </div>
              </div>
            </details>

            <details class="section" open>
              <summary>Layout</summary>
              <div class="secbody">
                <div class="row two">
                  <div class="row">
                    <label for="view">View</label>
                    <select id="view">
                      <option value="panel"${c.view === "panel" ? " selected" : ""}>Panel</option>
                      <option value="list"${c.view === "list" ? " selected" : ""}>List</option>
                    </select>
                  </div>
                  <div class="row">
                    <label for="info_position">Info position</label>
                    <select id="info_position">
                      <option value="above"${c.info_position !== "below" ? " selected" : ""}>Above ports</option>
                      <option value="below"${c.info_position === "below" ? " selected" : ""}>Below ports</option>
                    </select>
                  </div>

                </div>${c.view === "panel" ? `

                <div class="row">
                  <label for="background_image">Panel background image (optional)</label>
                  <input id="background_image" type="text" placeholder="/local/your_switch.png" value="${c.background_image != null ? this._escape(c.background_image) : ""}">
                  <div class="hint">Only used in Panel view.</div>
                ` : ""}
</div>${c.view === "panel" ? `

                <div class="row inline">
                  <label for="calibration_mode">Layout Editor</label><div class="helpiconbtn" data-help-title="Layout Editor" data-help="layout_editor"><ha-icon icon="mdi:help-circle-outline"></ha-icon></div>
                  <ha-switch id="calibration_mode" ${c.calibration_mode ? " checked" : ""}${c.view === "list" ? " disabled" : ""}></ha-switch>
                </div>
                ` : ""}
<div class="row two">${c.view === "panel" ? `
                  <div class="row">
                    <div class="rowhead"><label for="ports_per_row">Ports per row</label><div class="helpiconbtn" data-help-title="Ports per row" data-help="ports_per_row"><ha-icon icon="mdi:help-circle-outline"></ha-icon></div></div>
                    <input id="ports_per_row" type="number" min="1" value="${(this._editingFields?.has('ports_per_row') && this._draftValues?.ports_per_row != null) ? this._draftValues.ports_per_row : (c.ports_per_row != null ? Number(c.ports_per_row) : 24)}"${c.view === "list" ? " disabled" : ""}>
                  </div>
                  <div class="row">
                    <div class="rowhead"><label for="panel_width">Panel width</label><div class="helpiconbtn" data-help-title="Panel width" data-help="panel_width"><ha-icon icon="mdi:help-circle-outline"></ha-icon></div></div>
                    <input id="panel_width" type="number" min="0" value="${(this._editingFields?.has('panel_width') && this._draftValues?.panel_width != null) ? this._draftValues.panel_width : (c.panel_width != null ? Number(c.panel_width) : 740)}"${c.view === "list" ? " disabled" : ""}>
                  </div>
                ` : ""}</div>

                <div class="row">${c.view === "panel" ? `
                  <div class="rowhead"><label for="port_scale">Port scale</label><div class="helpiconbtn" data-help-title="Port scale" data-help="port_scale"><ha-icon icon="mdi:help-circle-outline"></ha-icon></div></div>
                  <input id="port_scale" type="number" step="0.05" min="0.1" value="${c.port_scale != null ? Number(c.port_scale) : 1}"${c.view === "list" ? " disabled" : ""}>
                ` : ""}</div>

                <div class="row two">${c.view === "panel" ? `
                  <div class="row">
                    <div class="rowhead">
                      <label for="horizontal_port_gap">Horizontal port gap</label>
                      <div class="helpiconbtn" data-help-title="Horizontal port gap" data-help="horizontal_port_gap"><ha-icon icon="mdi:help-circle-outline"></ha-icon></div>
                    </div>
                    <input id="horizontal_port_gap" type="number" min="0" value="${(this._draftValues?.horizontal_port_gap != null) ? this._draftValues.horizontal_port_gap : (c.horizontal_port_gap != null ? Number(c.horizontal_port_gap) : 10)}"${c.view === "list" ? " disabled" : ""}>
                  </div>
                  <div class="row">
                    <div class="rowhead">
                      <label for="vertical_port_gap">Vertical port gap</label>
                      <div class="helpiconbtn" data-help-title="Vertical port gap" data-help="vertical_port_gap"><ha-icon icon="mdi:help-circle-outline"></ha-icon></div>
                    </div>
                    <input id="vertical_port_gap" type="number" min="0" value="${(this._draftValues?.vertical_port_gap != null) ? this._draftValues.vertical_port_gap : (c.vertical_port_gap != null ? Number(c.vertical_port_gap) : 10)}"${c.view === "list" ? " disabled" : ""}>
                  </div>
                ` : ""}</div>

              </div>
            </details>

            <details class="section" open>
              <summary>Appearance</summary>
              <div class="secbody">

                <div class="row">
                  <label for="color_mode">Port colors</label>
                  <select id="color_mode">
                    <option value="state"${(c.color_mode !== "speed") ? " selected" : ""}>State (Admin/Oper)</option>
                    <option value="speed"${(c.color_mode === "speed") ? " selected" : ""}>Speed</option>
                  </select>
                  <div class="hint">Choose whether port colors represent port state or link speed.</div>
                  ${stateColorsHtml}${speedColorsHtml}
                </div>${_hasBandwidth ? `

                <div class="row inline">
                  <div class="rowhead">
                    <label for="speed_click_opens_graph">Open traffic graph on port click</label>
                    <div class="helpiconbtn" icon="mdi:help-circle-outline" data-help-title="Open traffic graph on port click" data-help="speed_click_opens_graph"><ha-icon icon="mdi:help-circle-outline"></ha-icon></div>
                  </div>
                  <ha-switch id="speed_click_opens_graph" ${c.speed_click_opens_graph ? " checked" : ""}></ha-switch>
                </div>

                ` : ""}${c.view === "panel" ? `

                <div class="row inline" style="gap:10px; align-items:center;">
  <label for="show_labels" style="flex:1 1 auto;">Show port labels</label>
  <select id="label_position" style="width:160px; margin-right:6px;"
    ${c.show_labels === false || c.view === "list" ? " disabled" : ""}>
    <option value="below"${(c.label_position || "below") === "below" ? " selected" : ""}>Below</option>
    <option value="above"${(c.label_position || "below") === "above" ? " selected" : ""}>Above</option>
    <option value="inside"${(c.label_position || "below") === "inside" ? " selected" : ""}>Inside</option>
    <option value="split"${(c.label_position || "below") === "split" ? " selected" : ""}>Split (2 row)</option>
  </select>
  <div class="helpiconbtn" data-help-title="Label position" data-help="label_position"><ha-icon icon="mdi:help-circle-outline"></ha-icon></div>
  <ha-switch id="show_labels" ${c.show_labels !== false ? "checked" : ""}${c.view === "list" ? " disabled" : ""}></ha-switch>
</div>
` : ""}${c.view === "panel" ? `
<div class="row inline">
                  <label for="label_numbers_only">Labels: numbers only</label>
                  <ha-switch id="label_numbers_only" ${c.label_numbers_only ? " checked" : ""}${c.show_labels === false || c.view === "list" ? " disabled" : ""}></ha-switch>
                </div>



<div class="row inline" style="gap:10px; align-items:center;">
  <div class="rowhead" style="display:flex; align-items:center; justify-content:flex-start; gap:6px; flex:1 1 auto;">
    <label for="label_numbers_from" style="margin:0;">Numbers from</label>
    <div class="helpiconbtn" data-help-title="Numbers from" data-help="label_numbers_from"><ha-icon icon="mdi:help-circle-outline"></ha-icon></div>
  </div>
  <select id="label_numbers_from" style="width:160px; margin-right:6px;"${c.show_labels === false || c.view === "list" || c.label_numbers_only !== true ? " disabled" : ""}>
    <option value="index"${(c.label_numbers_from !== "port_name") ? " selected" : ""}>Index</option>
    <option value="port_name"${(c.label_numbers_from === "port_name") ? " selected" : ""}>Port name</option>
  </select>
  <!-- spacer to keep this dropdown aligned with the row above (which has help+switch on the right) -->
  <div style="width:82px;"></div>
</div>
<div class="row inline" style="gap:10px; align-items:center;">
  <div class="rowhead" style="display:flex; align-items:center; gap:6px; flex:1 1 auto;">
    <label for="label_outline" style="margin:0;">Outline port labels</label>
    <div class="helpiconbtn" data-help-title="Outline port labels" data-help="label_outline"><ha-icon icon="mdi:help-circle-outline"></ha-icon></div>
  </div>
  <ha-switch id="label_outline"${c.label_outline ? " checked" : ""}${c.show_labels === false || c.view === "list" ? " disabled" : ""}></ha-switch>
</div>
` : ""}${c.view === "panel" ? `
<div class="row">
                  <label for="label_size">Label font size</label>
                  <input id="label_size" type="number" min="1" value="${c.label_size != null ? Number(c.label_size) : 8}"${c.view === "list" ? " disabled" : ""}>
                </div>

                
                ` : ""}${c.view === "panel" ? `
<div class="row two">
                  <div class="row">
                    <label for="label_color">Label font color</label>
                    <div class="inline">
                      <input id="label_color" type="color" value="${c.label_color != null ? String(c.label_color) : "#ffffff"}">
                      <button class="btn sm" id="label_color_clear" type="button" title="Use default label color">Clear</button>
                    </div>
                    <div class="hint">Clear restores the default theme color.</div>
                  </div>

                  ` : ""}
${c.view === "panel" ? `
<div class="row">
                    <label for="label_bg_color">Label background color</label>
                    <div class="inline">
                      <input id="label_bg_color" type="color" value="${c.label_bg_color != null ? String(c.label_bg_color) : "#000000"}">
                      <button class="btn sm" id="label_bg_color_clear" type="button" title="Use default label background color">Clear</button>
                    </div>

` : ""}                    <div class="hint">Clear restores the default background.</div>
                  </div>
                </div>


              </div>
            </details>

            
            <details class="section" open>
              <summary>Content</summary>
              <div class="secbody">

                <div class="row inline">
                  <label for="show_diagnostics">Show Diagnostics</label><div class="helpiconbtn" icon="mdi:help-circle-outline" data-help-title="Show Diagnostics" data-help="show_diagnostics"><ha-icon icon="mdi:help-circle-outline"></ha-icon></div>
                  <ha-switch id="show_diagnostics" ${c.hide_diagnostics ? "" : " checked"}></ha-switch>
                </div>

                ${c.hide_diagnostics ? "" : `
                  <div class="row">
                    <div class="rowhead"><label>Diagnostics order</label><div class="helpiconbtn" icon="mdi:help-circle-outline" data-help-title="Diagnostics order" data-help="diagnostics_order"><ha-icon icon="mdi:help-circle-outline"></ha-icon></div></div>
                    <div class="diaglist">
                      ${(() => {
                        const rawOrder = Array.isArray(c.diagnostics_order) && c.diagnostics_order.length
                          ? c.diagnostics_order
                          : ["hostname","manufacturer","model","firmware_revision","uptime"];
                        const enabledMap = (c.diagnostics_enabled && typeof c.diagnostics_enabled === "object") ? c.diagnostics_enabled : {};
                        const order = this._injectAutoDiagDefaults(rawOrder, enabledMap);
                        return order.map((key, idx) => {
                          const enabled = enabledMap[key] !== false;
                          const label = this._diagnosticLabel(key);
                          const isCustom = key.includes(".");
                          return `
                            <div class="diagitem ${enabled ? "" : "disabled"}" data-diag="${this._escape(key)}">
                              <div class="diagname" title="${this._escape(label)}">${this._escape(label)}</div>
                              <div class="diagactions">
                                <button class="btn icon sm diag-up" data-diag="${this._escape(key)}" title="Move up" ${idx===0?'disabled':''}>▲</button>
                                <button class="btn icon sm diag-down" data-diag="${this._escape(key)}" title="Move down" ${idx===order.length-1?'disabled':''}>▼</button>
                                ${isCustom ? `<button class="btn icon sm diag-remove" data-diag="${this._escape(key)}" title="Remove">✕</button>` : ``}
                              </div>
                            </div>
                          `;
                        }).join("");
                      })()}
                    </div>

                    <div class="row">
                      <label for="diag_add_input" class="sub">Add diagnostic sensor</label>
                      <div class="inline">
                        <input id="diag_add_input" type="text" placeholder="sensor.some_sensor" list="diag_sensors">
                        <button class="btn sm" id="diag_add_btn" type="button">Add</button>
                      </div>
                      <datalist id="diag_sensors">
                        ${this._hass ? Object.keys(this._hass.states).filter(e=>e.startsWith("sensor.")).map(e=>`<option value="${e}"></option>`).join("") : ""}
                      </datalist>
                      <div class="hint">Click a row to enable/disable. Built-in items can be reordered; custom sensors can also be removed.</div>
                    </div>
                  </div>
                `}

                <div class="row inline">
                  <label for="show_virtual_interfaces">Show Virtual Interfaces</label><div class="helpiconbtn" icon="mdi:help-circle-outline" data-help-title="Show Virtual Interfaces" data-help="show_virtual"><ha-icon icon="mdi:help-circle-outline"></ha-icon></div>
                  <ha-switch id="show_virtual_interfaces" ${c.hide_virtual_interfaces ? "" : " checked"}></ha-switch>
                </div>

                <div class="row inline">
                  <label for="hide_control_buttons">Hide control buttons</label><div class="helpiconbtn" icon="mdi:help-circle-outline" data-help-title="Hide control buttons" data-help="hide_controls"><ha-icon icon="mdi:help-circle-outline"></ha-icon></div>
                  <ha-switch id="hide_control_buttons" ${c.hide_control_buttons ? " checked" : ""}></ha-switch>
                </div>

                ${c.hide_virtual_interfaces ? "" : `
                  <div class="row">
                    <div class="rowhead"><label>Virtual interfaces (override)</label><div class="helpiconbtn" icon="mdi:help-circle-outline" data-help-title="Virtual interfaces (override)" data-help="virtual_overrides"><ha-icon icon="mdi:help-circle-outline"></ha-icon></div></div>
                  </div>

                  ${virtualOverridesHtml}
                `}

                <div class="divider"></div>

                <div class="row inline">
                  <label for="show_uplinks_separately">Show uplinks separately in layout</label><div class="helpiconbtn" icon="mdi:help-circle-outline" data-help-title="Show uplinks separately in layout" data-help="show_uplinks_separately"><ha-icon icon="mdi:help-circle-outline"></ha-icon></div>
                  <ha-switch id="show_uplinks_separately" ${c.show_uplinks_separately ? " checked" : ""}></ha-switch>
                </div>

                ${c.show_uplinks_separately ? `
                  <div class="row">
                    <div class="rowhead"><label>Uplink ports</label><div class="helpiconbtn" icon="mdi:help-circle-outline" data-help-title="Uplink ports" data-help="uplink_ports"><ha-icon icon="mdi:help-circle-outline"></ha-icon></div></div>
                    ${uplinkPortsHtml}
                  </div>
                ` : ""}

                <div class="divider"></div>
<div class="divider"></div>

                <div class="row">
                  <div class="rowhead"><label>Hide ports</label><div class="helpiconbtn" icon="mdi:help-circle-outline" data-help-title="Hide ports" data-help="hide_ports"><ha-icon icon="mdi:help-circle-outline"></ha-icon></div></div>
                          ${hidePortsHtml}
                </div>

              </div>
            </details>

          </div>
        `;

        const root = this.shadowRoot;

        // Ensure HA icons render inside the editor
        root.querySelectorAll("ha-icon").forEach((el) => { try { el.hass = this._hass; } catch (e) {} });

        // Title (use draft value to prevent re-render on every keystroke)
        const titleEl = root.getElementById("title");
        titleEl?.addEventListener("focus", () => {
          this._editingTitle = true;
          // Initialize draft from current config once the user starts editing.
          if (this._draftTitle === null || this._draftTitle === undefined) {
            this._draftTitle = this._config?.title ?? "";
          }
        });
        titleEl?.addEventListener("input", (ev) => {
          this._draftTitle = ev.target.value;
        });
        const commitTitle = () => {
          const next = (this._draftTitle ?? "").toString();
          const cur = (this._config?.title ?? "").toString();
          this._editingTitle = false;
          if (next !== cur) this._updateConfig("title", next);
          // Keep draft in sync with committed value.
          this._draftTitle = null;
        };
        titleEl?.addEventListener("blur", commitTitle);
        titleEl?.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            titleEl.blur();
          }
          if (ev.key === "Escape") {
            // Revert draft and stop editing.
            this._draftTitle = null;
            this._editingTitle = false;
            this._rendered = false;
            this._render();
          }
        });

// Switch device
root.getElementById("device")?.addEventListener("change", (ev) => {
  const next = (ev.target.value || "").toString();
  this._updateConfig("device", next);
  // Force port list + datalist to refresh for the new device.
  this._lastPortsSig = "";
  this._render();
});

        // View
        root.getElementById("view")?.addEventListener("change", (ev) => {
          this._updateConfig("view", ev.target.value || "panel");
        });

        // Panel layout basics (only relevant in panel view)
        root.getElementById("ports_per_row")?.addEventListener("change", (ev) => {
          const v = parseInt(ev.target.value, 10);
          this._updateConfig("ports_per_row", (Number.isFinite(v) && v > 0) ? v : 24);
        });
        root.getElementById("panel_width")?.addEventListener("change", (ev) => {
          const v = parseInt(ev.target.value, 10);
          this._updateConfig("panel_width", (Number.isFinite(v) && v >= 0) ? v : 740);
        });
        // Drafted number inputs (avoid HA editor re-renders clobbering typing)
        const bindDraftNumber = (id, key, fallback, parseFn) => {
          const el = root.getElementById(id);
          if (!el) return;
          let committed = false;

          const commit = () => {
            if (committed) return;
            committed = true;
            this._editingFields?.delete(key);
            const raw = (this._draftValues && this._draftValues[key] != null) ? this._draftValues[key] : el.value;
            try { if (this._draftValues) delete this._draftValues[key]; } catch (e) {}
            const parsed = (parseFn ? parseFn(raw) : parseInt(raw, 10));
            const v = Number.isFinite(parsed) ? parsed : fallback;
            this._updateConfig(key, v);
            // allow next edit cycle
            setTimeout(() => { committed = false; }, 0);
          };

          el.addEventListener("focus", () => {
            this._editingFields?.add(key);
            if (this._draftValues && this._draftValues[key] == null) this._draftValues[key] = String(el.value ?? "");
          });
          el.addEventListener("input", () => {
            if (this._draftValues) this._draftValues[key] = String(el.value ?? "");
          });
          el.addEventListener("blur", commit);
          el.addEventListener("change", commit);
        };

        bindDraftNumber("ports_per_row", "ports_per_row", 24, (raw) => {
          const n = parseInt(String(raw ?? "").trim(), 10);
          return Number.isFinite(n) && n >= 1 ? n : 24;
        });
        bindDraftNumber("panel_width", "panel_width", 740, (raw) => {
          const n = parseInt(String(raw ?? "").trim(), 10);
          return Number.isFinite(n) && n >= 0 ? n : 740;
        });
        bindDraftNumber("gap", "gap", 10, (raw) => {
          const n = parseInt(String(raw ?? "").trim(), 10);
          return Number.isFinite(n) && n >= 0 ? n : 10;
        });



        // Info position
        root.getElementById("info_position")?.addEventListener("change", (ev) => {
          this._updateConfig(
            "info_position",
            ev.target.value === "below" ? "below" : "above",
          );
        });

        // Port colors (state vs speed)
        root.getElementById("color_mode")?.addEventListener("change", (ev) => {
          const v = String(ev.target.value || "state");
          this._updateConfig("color_mode", v === "speed" ? "speed" : "state");
        });

        root.getElementById("speed_click_opens_graph")?.addEventListener("change", (ev) => {
          this._updateConfig("speed_click_opens_graph", !!ev.target.checked);
        });

        // Speed colors: show full supported speeds list
        root.getElementById("show_all_speeds")?.addEventListener("change", (ev) => {
          this._updateConfig("show_all_speeds", !!ev.target.checked);
          this._rendered = false;
          this._render();
        });

        // Reset buttons (icon buttons in section headers)
        root.getElementById("speed_reset")?.addEventListener("click", (ev) => {
          ev.preventDefault();
          this._updateConfig("speed_colors", null);
          this._rendered = false;
          this._render();
        });
        root.getElementById("state_reset")?.addEventListener("click", (ev) => {
          ev.preventDefault();
          this._updateConfig("state_colors", null);
          this._rendered = false;
          this._render();
        });

        const speedPalette = this._defaultSpeedPalette();
        const statePalette = this._defaultStatePalette();

        
const updateSpeedColor = (label, color) => {
          const lab = String(label || "").trim() || "Unknown";
          const cval = String(color || "").trim();
          if (!/^#[0-9a-fA-F]{6}$/.test(cval)) return;

          const cur = (this._config?.speed_colors && typeof this._config.speed_colors === "object")
            ? { ...this._config.speed_colors }
            : {};
          const def = speedPalette[lab] || speedPalette["Disconnected"] || speedPalette["Unknown"];

          const isDefault = (String(def || "").toLowerCase() === cval.toLowerCase());

          if (lab === "Disconnected") {
            if (isDefault) {
              delete cur["Disconnected"];
              delete cur["Unknown"];
            } else {
              cur["Disconnected"] = cval;
              cur["Unknown"] = cval;
            }
          } else {
            if (isDefault) delete cur[lab];
            else cur[lab] = cval;
          }

          this._updateConfig("speed_colors", Object.keys(cur).length ? cur : null);
        };

        

        const updateStateColor = (key, color) => {
          const k = String(key || "").trim();
          const cval = String(color || "").trim();
          if (!/^#[0-9a-fA-F]{6}$/.test(cval)) return;

          const cur = (this._config?.state_colors && typeof this._config.state_colors === "object")
            ? { ...this._config.state_colors }
            : {};
          const def = statePalette[k] || "#9ca3af";
          if (cval.toLowerCase() === String(def).toLowerCase()) delete cur[k];
          else cur[k] = cval;

          this._updateConfig("state_colors", Object.keys(cur).length ? cur : null);
        };

        // Live sync: picker -> hex (no config write), commit on change
        root.querySelectorAll("input.speedcolor").forEach((inp) => {
          inp.addEventListener("input", () => {
            const lab = inp.dataset.speed || "Unknown";
            const hex = root.querySelector(`input.speedhex[data-speed="${lab}"]`);
            if (hex) hex.value = inp.value;
          });
          inp.addEventListener("change", () => {
            const lab = inp.dataset.speed || "Unknown";
            updateSpeedColor(lab, inp.value);
          });
        });

        root.querySelectorAll("input.statecolor").forEach((inp) => {
          inp.addEventListener("input", () => {
            const lab = inp.dataset.state || "up_up";
            const hex = root.querySelector(`input.statehex[data-state="${lab}"]`);
            if (hex) hex.value = inp.value;
          });
          inp.addEventListener("change", () => {
            const lab = inp.dataset.state || "up_up";
            updateStateColor(lab, inp.value);
          });
        });

        // Commit hex edits on change (avoid rerender while typing)
        root.querySelectorAll("input.speedhex").forEach((inp) => {
          inp.addEventListener("change", () => {
            const lab = inp.dataset.speed || "Unknown";
            let v = String(inp.value || "").trim();
            if (!v) return;
            if (!v.startsWith("#")) v = `#${v}`;
            if (!/^#[0-9a-fA-F]{6}$/.test(v)) return;
            const color = root.querySelector(`input.speedcolor[data-speed="${lab}"]`);
            if (color) color.value = v;
            updateSpeedColor(lab, v);
          });
        });

        root.querySelectorAll("input.statehex").forEach((inp) => {
          inp.addEventListener("change", () => {
            const lab = inp.dataset.state || "up_up";
            let v = String(inp.value || "").trim();
            if (!v) return;
            if (!v.startsWith("#")) v = `#${v}`;
            if (!/^#[0-9a-fA-F]{6}$/.test(v)) return;
            const color = root.querySelector(`input.statecolor[data-state="${lab}"]`);
            if (color) color.value = v;
            updateStateColor(lab, v);
          });
        });

        // Hide ports checklist
        root.querySelectorAll("input[data-hide-port]")?.forEach((el) => {
          el.addEventListener("change", () => {
            const selected = Array.from(root.querySelectorAll("input[data-hide-port]"))
              .filter(x => x.checked)
              .map(x => String(x.getAttribute("data-hide-port") || "").trim())
              .filter(Boolean);
            this._updateConfig("hide_ports", selected);
          });
        });

        // Uplink ports checklist
        root.querySelectorAll("input[data-uplink-port]")?.forEach((el) => {
          el.addEventListener("change", () => {
            const selected = Array.from(root.querySelectorAll("input[data-uplink-port]"))
              .filter(x => x.checked)
              .map(x => String(x.getAttribute("data-uplink-port") || "").trim())
              .filter(Boolean);
            this._updateConfig("uplink_ports", selected);
          });
        });

        
        // Background image + positioning
        root.getElementById("background_image")?.addEventListener("change", (ev) => {
          const v = String(ev.target.value || "").trim();
          this._updateConfig("background_image", v ? v : null);
        });
        root.getElementById("ports_offset_x")?.addEventListener("change", (ev) => {
          const v = parseFloat(ev.target.value);
          this._updateConfig("ports_offset_x", Number.isFinite(v) ? v : 0);
        });
        root.getElementById("ports_offset_y")?.addEventListener("change", (ev) => {
          const v = parseFloat(ev.target.value);
          this._updateConfig("ports_offset_y", Number.isFinite(v) ? v : 0);
        });
        root.getElementById("port_scale")?.addEventListener("change", (ev) => {
          const v = parseFloat(ev.target.value);
          this._updateConfig("port_scale", (Number.isFinite(v) && v > 0) ? v : 1);
        });

// Horizontal/Vertical port gap (canonical keys)
root.getElementById("horizontal_port_gap")?.addEventListener("change", (ev) => {
  const v = Number(ev.target.value);
  const next = { ...(this._config || {}) };
  next.horizontal_port_gap = Number.isFinite(v) ? v : 10;
  delete next.gap; delete next.gap_x; delete next.gap_y; delete next.port_gap_x; delete next.port_gap_y;
  this._config = next;
  this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: next } }));
});
root.getElementById("vertical_port_gap")?.addEventListener("change", (ev) => {
  const v = Number(ev.target.value);
  const next = { ...(this._config || {}) };
  next.vertical_port_gap = Number.isFinite(v) ? v : 10;
  delete next.gap; delete next.gap_x; delete next.gap_y; delete next.port_gap_x; delete next.port_gap_y;
  this._config = next;
  this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: next } }));
});
        root.getElementById("port_positions")?.addEventListener("change", (ev) => {
          const raw = String(ev.target.value || "").trim();
          if (!raw) { this._updateConfig("port_positions", null); return; }
          try {
            const obj = JSON.parse(raw);
            this._updateConfig("port_positions", (obj && typeof obj === "object") ? obj : null);
          } catch (e) {
            // Keep the user's text, but don't break the editor; ignore invalid JSON.
          }
        });


        root.getElementById("calibration_mode")?.addEventListener("change", (ev) => {
          this._updateConfig("calibration_mode", !!ev.target.checked);
        
          try {
            const prefix = (this._config?.device || "") ? String(this._config.device) : "all";
            localStorage.removeItem(`ssm_calib_force_off:${prefix}`);
          } catch (e) {}
});


        // Content toggles
        // UI uses "Show …" switches, but config stores the inverse for diagnostics/virtual.
        root.getElementById("show_diagnostics")?.addEventListener("change", (ev) => {
          // checked = show
          this._updateConfig("hide_diagnostics", !ev.target.checked);
          this._render();
        });

        root.getElementById("show_virtual_interfaces")?.addEventListener("change", (ev) => {
          this._updateConfig("hide_virtual_interfaces", !ev.target.checked);
          this._render();
        });

        root.getElementById("hide_control_buttons")?.addEventListener("change", (ev) => {
          this._updateConfig("hide_control_buttons", !!ev.target.checked);
          this._render();
        });

        root.getElementById("show_uplinks_separately")?.addEventListener("change", (ev) => {
          this._updateConfig("show_uplinks_separately", !!ev.target.checked);
          this._render();
        });


        // Labels under ports (Panel view)
        root.getElementById("show_labels")?.addEventListener("change", (ev) => {
          this._updateConfig("show_labels", !!ev.target.checked);
        });

        root.getElementById("label_numbers_only")?.addEventListener("change", (ev) => {
  this._updateConfig("label_numbers_only", !!ev.target.checked);
  this._render(); // show/hide dependent fields immediately
});

root.getElementById("label_numbers_from")?.addEventListener("change", (ev) => {
  this._updateConfig("label_numbers_from", String(ev.target.value || "index"));
  // no full re-render needed; labels update during normal redraw
});// Outline port labels (only used when "Port labels by number" is enabled)
root.getElementById("label_outline")?.addEventListener("change", (ev) => {
  this._updateConfig("label_outline", ev.target.checked === true);
});


// Label position
        root.getElementById("label_position")?.addEventListener("change", (ev) => {
          const v = String(ev.target.value || "below");
          const ok = (v === "below" || v === "above" || v === "inside" || v === "split");
          this._updateConfig("label_position", ok ? v : "below");
        });

        // Label size
        root.getElementById("label_size")?.addEventListener("change", (ev) => {
          const v = parseInt(ev.target.value, 10);
          this._updateConfig("label_size", Number.isFinite(v) ? v : 8);
        });

        // Label color
        root.getElementById("label_color")?.addEventListener("change", (ev) => {
          const v = String(ev.target.value || "").trim();
          this._updateConfig("label_color", v || null);
        });

        root.getElementById("label_color_clear")?.addEventListener("click", () => {
          this._updateConfig("label_color", null);
          const inp = root.getElementById("label_color");
          if (inp) inp.value = "#ffffff";
        });

        // Label background color
        root.getElementById("label_bg_color")?.addEventListener("change", (ev) => {
          const v = String(ev.target.value || "").trim();
          this._updateConfig("label_bg_color", v || null);
        });
        root.getElementById("label_bg_color_clear")?.addEventListener("click", () => {
          this._updateConfig("label_bg_color", null);
          const inp = root.getElementById("label_bg_color");
          if (inp) inp.value = "#000000";
        });
        // Diagnostics order (auto-discovered sensors)
        const moveDiag = (from, to) => {
          const def = ["hostname","manufacturer","model","firmware_revision","uptime"];
          const order = Array.isArray(this._config.diagnostics_order) && this._config.diagnostics_order.length
            ? [...this._config.diagnostics_order]
            : [...def];
          if (from < 0 || from >= order.length || to < 0 || to >= order.length) return;
          const [it] = order.splice(from, 1);
          order.splice(to, 0, it);
          this._updateConfig("diagnostics_order", order);
        };
        root.querySelectorAll("button.diagup").forEach((btn) => {
          btn.addEventListener("click", (ev) => {
            ev.preventDefault();
            const idx = Number(btn.dataset.idx);
            if (!Number.isFinite(idx)) return;
            moveDiag(idx, idx - 1);
          });
        });
        root.querySelectorAll("button.diagdown").forEach((btn) => {
          btn.addEventListener("click", (ev) => {
            ev.preventDefault();
            const idx = Number(btn.dataset.idx);
            if (!Number.isFinite(idx)) return;
            moveDiag(idx, idx + 1);
          });
        });

        // Chips: add/remove helpers (Hide ports / Uplink ports)
        const normList = (arr) => {
          const out = [];
          const seen = new Set();
          (arr || []).forEach(v => {
            const s = String(v || "").trim();
            if (!s) return;
            const k = s.toLowerCase();
            if (seen.has(k)) return;
            seen.add(k);
            out.push(s);
          });
          return out;
        };

        const addToList = (key, value) => {
          const v = String(value || "").trim();
          if (!v) return;
          const cur = normList(this._config?.[key]);
          const exists = cur.some(x => x.toLowerCase() === v.toLowerCase());
          const next = exists ? cur : [...cur, v];
                    next.sort((a,b)=>_ssmNaturalPortCompare(a,b));
          if (!exists) this._updateConfig(key, next);
        };

        const removeFromList = (key, value) => {
          const v = String(value || "").trim().toLowerCase();
          if (!v) return;
          const cur = normList(this._config?.[key]);
          const next = cur.filter(x => x.toLowerCase() !== v);
                    next.sort((a,b)=>_ssmNaturalPortCompare(a,b));
          this._updateConfig(key, next);
        };

        const bindChipAdd = (key, inputId, btnId) => {
          const inp = root.getElementById(inputId);
          const btn = root.getElementById(btnId);
          const commit = () => {
            if (!inp) return;
            addToList(key, inp.value);
            inp.value = "";
          };
          inp?.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
          });
          btn?.addEventListener("click", (e) => { e.preventDefault(); commit(); });
          inp?.addEventListener("blur", () => {
            // don't auto-add on blur; keep explicit
          });
        };

        bindChipAdd("hide_ports", "hide_ports_add", "hide_ports_add_btn");
        bindChipAdd("uplink_ports", "uplink_ports_add", "uplink_ports_add_btn");
        bindChipAdd("virtual_overrides", "virtual_overrides_add", "virtual_overrides_add_btn");

        this._ssmConvertHintsToHelp(root);

        const addPrefix = (value) => {
          const v = String(value || "").trim();
          if (!v) return;
          const cur = normList(String(this._config?.physical_prefixes || "").split(","));
          const exists = cur.some(x => x.toLowerCase() === v.toLowerCase());
          const next = exists ? cur : [...cur, v];
                    next.sort((a,b)=>_ssmNaturalPortCompare(a,b));
          if (!exists) this._updateConfig("physical_prefixes", next.join(", "));
        };
        const removePrefix = (value) => {
          const v = String(value || "").trim().toLowerCase();
          if (!v) return;
          const cur = normList(String(this._config?.physical_prefixes || "").split(","));
          const next = cur.filter(x => x.toLowerCase() !== v);
                    next.sort((a,b)=>_ssmNaturalPortCompare(a,b));
          this._updateConfig("physical_prefixes", next.join(", "));
        };

        const bindPrefixAdd = () => {
          const inp = root.getElementById("physical_prefixes_add");
          const btn = root.getElementById("physical_prefixes_add_btn");
          const commit = () => {
            if (!inp) return;
            addPrefix(inp.value);
            inp.value = "";
          };
          inp?.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
          });
          btn?.addEventListener("click", (e) => { e.preventDefault(); commit(); });
        };
        bindPrefixAdd();

        root.querySelectorAll(".chip[data-chip-kind]").forEach((b) => {
          b.addEventListener("click", (e) => {
            e.preventDefault();
            const kind = String(b.dataset.chipKind || "");
            const val = String(b.dataset.chipVal || "");
            if (kind === "hide_ports") removeFromList("hide_ports", val);
            if (kind === "uplink_ports") removeFromList("uplink_ports", val);
            if (kind === "virtual_overrides") removeFromList("virtual_overrides", val);
            if (kind === "physical_prefixes") removePrefix(val);
          });
        });
// Diagnostics order (toggle/reorder/add)
        const diagList = root.querySelector(".diaglist");
        if (diagList) {
          const getDiagOrder = () => {
            const order = Array.isArray(this._config.diagnostics_order) && this._config.diagnostics_order.length
              ? [...this._config.diagnostics_order]
              : ["hostname","manufacturer","model","firmware","uptime"];
            return order;
          };
          const setDiagOrder = (order) => {
            this._updateConfig("diagnostics_order", order);
          };
          const getEnabledMap = () => {
            const m = (this._config.diagnostics_enabled && typeof this._config.diagnostics_enabled === "object")
              ? { ...this._config.diagnostics_enabled }
              : {};
            return m;
          };
          const setEnabledMap = (m) => {
            this._updateConfig("diagnostics_enabled", m);
          };

          const toggleDiag = (key) => {
            const m = getEnabledMap();
            m[key] = m[key] === false ? true : false;
            setEnabledMap(m);
            this._render();
          };

          diagList.addEventListener("click", (ev) => {
            const btn = ev.target.closest("button");
            if (btn) return; // handled below
            const row = ev.target.closest(".diagitem");
            if (!row) return;
            const key = row.getAttribute("data-diag") || "";
            if (key) toggleDiag(key);
          });

          diagList.querySelectorAll("button.diag-up").forEach((b) => {
            b.addEventListener("click", (ev) => {
              const key = ev.currentTarget.getAttribute("data-diag") || "";
              const order = getDiagOrder();
              const i = order.indexOf(key);
              if (i > 0) {
                order.splice(i, 1);
                order.splice(i - 1, 0, key);
                setDiagOrder(order);
                this._render();
              }
              ev.stopPropagation();
            });
          });

          diagList.querySelectorAll("button.diag-down").forEach((b) => {
            b.addEventListener("click", (ev) => {
              const key = ev.currentTarget.getAttribute("data-diag") || "";
              const order = getDiagOrder();
              const i = order.indexOf(key);
              if (i !== -1 && i < order.length - 1) {
                order.splice(i, 1);
                order.splice(i + 1, 0, key);
                setDiagOrder(order);
                this._render();
              }
              ev.stopPropagation();
            });
          });

          diagList.querySelectorAll("button.diag-remove").forEach((b) => {
            b.addEventListener("click", (ev) => {
              const key = ev.currentTarget.getAttribute("data-diag") || "";
              const order = getDiagOrder().filter((x) => x !== key);
              setDiagOrder(order);
              const m = getEnabledMap();
              if (this._isAutoDefaultDiagKey(key)) m[key] = false;
              else delete m[key];
              setEnabledMap(m);
              this._render();
              ev.stopPropagation();
            });
          });

          const addBtn = root.getElementById("diag_add_btn");
          const addInput = root.getElementById("diag_add_input");
          if (addBtn && addInput) {
            addBtn.addEventListener("click", () => {
              const val = String(addInput.value || "").trim();
              if (!val) return;
              const order = getDiagOrder();
              if (!order.includes(val)) order.push(val);
              setDiagOrder(order);
              const m = getEnabledMap();
              m[val] = true;
              setEnabledMap(m);
              addInput.value = "";
              this._render();
            });
          }
        }

        requestAnimationFrame(() => this._applyAutoScale());
        this._rendered = true;
      }
    
  
    _ssmConvertHintsToHelp(root) {
      // 1) Bind explicit help icons we placed in section headers (Virtual/Uplink/Hide).
      const helpText = {
        virtual_overrides:
          "Interfaces listed here are treated as Virtual. All others are treated as Physical. This affects classification even if the Virtual panel is hidden.",
        uplink_ports: "Select uplink ports so they can be placed separately from the main port grid in the layout.",
        hide_ports: "Hidden ports are removed from both Panel and List views.",
      };

      const HELP_TEXTS = {
  // Content
  diagnostics_order: {
    title: "Diagnostics order",
    text: "Controls which Diagnostics rows appear and in what order. Click a row to enable/disable it. Use ▲/▼ to reorder; custom sensors can also be removed."
  },
  show_diagnostics: {
    title: "Show Diagnostics",
    text: "Enable or hide the Diagnostics section on the card. When disabled, diagnostic rows are not shown."
  },
  show_virtual: {
    title: "Show Virtual Interfaces",
    text: "Show or hide the Virtual Interfaces panel. Classification still uses the override list even if the panel is hidden."
  },
  hide_controls: {
    title: "Hide control buttons",
    text: "Hides the Turn on/Turn off buttons in the card (Virtual Interfaces list + port popup). Useful if you want to avoid accidentally toggling ports from the UI."
  },
  show_uplinks_separately: {
    title: "Show uplinks separately in layout",
    text: "When enabled, ports you mark as Uplink ports can be positioned separately in the Layout Editor. This does not change which ports are shown on the card."
  },
  // Layout
  layout_editor: {
    title: "Layout Editor",
    text: "Opens an on-card layout editor so you can drag ports into place. Click Save to persist positions locally. Use the X button to exit the editor."
  },
  ports_per_row: {
    title: "Ports per row",
    text: "Panel view only. Controls how many ports are placed in each row when you are not using custom port positions."
  },
  panel_width: {
    title: "Panel width",
    text: "Panel view only. Sets the width of the panel canvas (in pixels)."
  },
  port_scale: {
    title: "Port scale",
    text: "Panel view only. Scales the size of port squares and labels."
  },
  port_gap: {
    title: "Port gap",
    text: "Panel view only. Spacing between ports when using automatic layout."
  },

  // Lists
  virtual_overrides: {
    title: "Virtual interfaces (override)",
    text: "Interfaces listed here are treated as Virtual. All others are treated as Physical. This affects classification even if the Virtual panel is hidden."
  },
  uplink_ports: {
    title: "Uplink ports",
    text: "Select uplink ports so Ports and Uplinks mode and the Layout Editor can keep them separate from the main port grid (if enabled)."
  },
  uplinks: { // backward-compatible key
    title: "Uplink ports",
    text: "Select uplink ports so Ports and Uplinks mode and the Layout Editor can keep them separate from the main port grid (if enabled)."
  },
  hide_ports: {
    title: "Hide ports",
    text: "Hidden ports are removed from both Panel and List views."
  },

  // Appearance
  label_font_color: {
    title: "Label font color",
    text: "Overrides the label text color for port labels. Use Clear to return to the default."
  },
  label_bg_color: {
    title: "Label background color",
    text: "Optional background behind port labels (Panel view) to improve contrast. Use Clear to remove and return to the default."
  },
  label_position: {
    title: "Label position",
    text: "Choose where the port labels render relative to the port squares. Below = under the port. Above = over the port. Inside = centered inside the port. Split (2 row) = top row labels above and bottom row labels below."
  },

  speed_click_opens_graph: {
    title: "Open traffic graph on port click",
    text: "Only applies when Port colors is set to Speed. When enabled, clicking a port opens the bandwidth traffic graph (if bandwidth sensors exist for that port). If no bandwidth sensors are found, the normal port information popup is shown instead."
  },

label_numbers_from: {
  title: "Numbers from",
  text: "When “Labels: numbers only” is enabled, choose where the number comes from: Index uses the interface index (IfIndex) when available (otherwise it falls back to the displayed order), while Port name extracts the right-most numbers from the port name."
},

label_outline: {
  title: "Outline port labels",
  text: "Adds a black outline around numeric port labels to improve readability on bright backgrounds. This only applies when \"Port labels by number\" is enabled."
},

vertical_port_gap: {
  title: "Vertical port gap",
  text: "Spacing between ports in the panel layout. Horizontal controls left/right spacing; Vertical controls top/bottom spacing. Custom port positions from the Layout Editor override automatic spacing."
},

horizontal_port_gap: {
  title: "Horizontal port gap",
  text: "Spacing between ports in the panel layout. Horizontal controls left/right spacing; Vertical controls top/bottom spacing. Custom port positions from the Layout Editor override automatic spacing."
},
};

const _ensureHelpPopover = (container) => {
  let pop = document.querySelector(".ssm-help-popover");
  if (pop) return pop;

  pop = document.createElement("div");
  pop.className = "ssm-help-popover";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-modal", "false");
  pop.style.position = "fixed";
  pop.style.display = "none";
  pop.innerHTML = `
    <div class="ssm-help-title">
      <div class="ssm-help-title-text"></div>
</div>
    <div class="ssm-help-body"></div>
  `;
  container.appendChild(pop);

  const close = () => {
    pop.style.display = "none";
    pop.removeAttribute("data-open");
  };

  // Click outside to close
  window.addEventListener("pointerdown", (e) => {
    if (pop.style.display === "none") return;
    const t = e.target;
    if (!pop.contains(t) && !t?.closest?.(".helpiconbtn")) close();
  }, { capture: true });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  return pop;
};

const _showHelpPopover = (btn, keyOrText, fallbackTitle) => {
  const pop = _ensureHelpPopover(root);

  const entry = HELP_TEXTS[keyOrText];
  const title = (entry?.title || fallbackTitle || "Help").trim();
  const text = (entry?.text || String(keyOrText || "")).trim();

  pop.querySelector(".ssm-help-title-text").textContent = title;
  pop.querySelector(".ssm-help-body").textContent = text;

  // Position near the button
  const r = btn.getBoundingClientRect();
  const pad = 10;
  pop.style.display = "block";
  pop.setAttribute("data-open", "1");

  // Temporarily show to measure
  const pr = pop.getBoundingClientRect();
  let left = Math.min(window.innerWidth - pr.width - pad, Math.max(pad, r.left));
  let top = r.bottom + 8;
  if (top + pr.height + pad > window.innerHeight) {
    top = Math.max(pad, r.top - pr.height - 8);
  }
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
};

const bindPopover = (btn, keyOrText, title) => {
  // Make click target less fiddly: larger, always clickable
  btn.style.cursor = "pointer";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    _showHelpPopover(btn, keyOrText, title);
  }, { passive: false });
};
      root.querySelectorAll(".helpiconbtn[data-help]").forEach((btn) => {
        const key = btn.getAttribute("data-help") || "";
        bindPopover(btn, key || "", (btn.getAttribute("data-help-title")||"Help"));

        // Hover tooltip should show the *help text*, not just the title.
        const entry = HELP_TEXTS[key];
        const tip = (entry?.text || entry?.title || key || "Help").trim();
        if (tip) btn.setAttribute("title", tip);
      });

      // 2) Back-compat: convert remaining inline hint blocks into hover/click help icons.
      const hints = root.querySelectorAll(".hint");
    hints.forEach((h) => {
      const text = (h.textContent || "").trim();
      const row = h.closest(".row");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "helpiconbtn";
      btn.setAttribute("aria-label", "Help");
      btn.innerHTML = `<ha-icon icon="mdi:help-circle-outline"></ha-icon>`;
      bindPopover(btn, text, (row?.querySelector("label")?.textContent || "Help").trim() || "Help");

      // Prefer placing the icon on the same line as the field title.
      if (row) {
        let rowhead = row.querySelector(":scope > .rowhead");
        if (!rowhead) {
          const firstLabel = row.querySelector(":scope > label");
          if (firstLabel) {
            rowhead = document.createElement("div");
            rowhead.className = "rowhead";
            // Move the label into the rowhead so the icon aligns right.
            row.insertBefore(rowhead, firstLabel);
            rowhead.appendChild(firstLabel);
          }
        }
        if (rowhead) {
          rowhead.appendChild(btn);
          h.remove();
          return;
        }
      }

      // Fallback: replace the hint with an icon line
      const helpline = document.createElement("div");
      helpline.className = "helpline";
      helpline.appendChild(btn);
      h.replaceWith(helpline);
    });

    // Ensure any existing help buttons are also aligned with the title row.
    root.querySelectorAll(".helpiconbtn[data-help]").forEach((btn) => {
      if (btn.closest(".rowhead")) return;
      const row = btn.closest(".row");
      if (!row) return;
      let rowhead = row.querySelector(":scope > .rowhead");
      if (!rowhead) {
        const firstLabel = row.querySelector(":scope > label");
        if (firstLabel) {
          rowhead = document.createElement("div");
          rowhead.className = "rowhead";
          row.insertBefore(rowhead, firstLabel);
          rowhead.appendChild(firstLabel);
        }
      }
      if (rowhead) rowhead.appendChild(btn);
    });
  }


}

    // Final guard in case something registered it between our initial check
    if (!customElements.get("snmp-switch-manager-card-editor")) {
      customElements.get("snmp-switch-manager-card-editor") || customElements.define("snmp-switch-manager-card-editor", SnmpSwitchManagerCardEditor);
    }
  });
}
