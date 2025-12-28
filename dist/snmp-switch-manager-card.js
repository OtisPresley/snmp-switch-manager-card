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
}

  setConfig(config) {
    this._config = {
      title: config.title ?? "",
      view: (config.view === "panel" ? "panel" : "list"),

      // Port color representation: "state" (default) or "speed"
      color_mode: (config.color_mode === "speed") ? "speed" : "state",

      ports_per_row: Number.isFinite(config.ports_per_row) ? Number(config.ports_per_row) : 24,
      panel_width: Number.isFinite(config.panel_width) ? Number(config.panel_width) : 740,
      port_size: Number.isFinite(config.port_size) ? Number(config.port_size) : 18,
      gap: Number.isFinite(config.gap) ? Number(config.gap) : 10,
      show_labels: config.show_labels !== false,
      label_size: Number.isFinite(config.label_size) ? Number(config.label_size) : 8,

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

      // Optional custom background image + port positioning (panel view only)
      background_image: (typeof config.background_image === "string" && config.background_image.trim()) ? config.background_image.trim() : null,
      ports_offset_x: Number.isFinite(config.ports_offset_x) ? Number(config.ports_offset_x) : 0,
      ports_offset_y: Number.isFinite(config.ports_offset_y) ? Number(config.ports_offset_y) : 0,
      ports_scale: Number.isFinite(config.ports_scale) ? Number(config.ports_scale) : 1,
      port_positions: (config.port_positions && typeof config.port_positions === "object") ? config.port_positions : null,
      physical_prefixes: (typeof config.physical_prefixes === "string") ? config.physical_prefixes : null,
      physical_regex: (typeof config.physical_regex === "string") ? config.physical_regex : null,

      calibration_mode: config.calibration_mode === true,

// Optional panel visibility
      hide_diagnostics: config.hide_diagnostics === true,
      hide_virtual_interfaces: config.hide_virtual_interfaces === true,
    };
    this._render();
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

    // While in Calibration mode, Lovelace frequently triggers hass updates which cause the card
    // to rebuild its entire DOM. That rebuild cancels pointer capture (drag 'drops') and resets
    // the calibration JSON textarea scroll. Mirror the existing graph/modal strategy: freeze
    // renders during calibration and let the user finish positioning first.
    if (this._config?.calibration_mode && this._freezeRenderWhileCalibrationActive) {
      return;
    }

    // While drag-calibrating, don't re-render on hass churn (it cancels pointer capture and 'drops' the drag)
    if (this._freezeRenderWhileDragging) {
      return;
    }

    this._render();
  }

  getCardSize() { return 5; }

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
    const def = ["hostname","manufacturer","model","firmware_revision","uptime"];
    const order = (Array.isArray(this._config?.diagnostics_order) && this._config.diagnostics_order.length)
      ? this._config.diagnostics_order
      : def;
    const out = [];
    for (const key of order) {
      const k = String(key || "");
      if (!def.includes(k)) continue;
      const eid = `sensor.${prefix}_${k}`;
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
    const explicit = Array.isArray(this._config.ports) && this._config.ports.length;

    if (this._config.anchor_entity && !this._anchorDeviceId) {
      await this._resolveAnchorDeviceId();
      this._render(); // allow re-render
    }

    const entries = explicit
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
        });

    if (!entries.length && !explicit) {
      const candidates = Object.keys(H).filter(k => k.startsWith("switch.")).slice(0, 20);
      return { phys: [], virt: [], diag: candidates };
    }

    const phys = [], virt = [];
    for (const [id, st] of entries) {
      const nRaw = String(st.attributes?.Name || id.split(".")[1] || "");
      const n = nRaw.toUpperCase();
      const rxStr = (this._config?.physical_regex || "").trim();
      const prefStr = (this._config?.physical_prefixes || "").trim();

      let isPhysical = false;

      // 1) Advanced override: regex (case-insensitive)
      if (rxStr) {
        try {
          const rx = new RegExp(rxStr, "i");
          isPhysical = rx.test(n) || rx.test(id);
        } catch (e) {
          // Invalid regex: fall back to prefixes/defaults
          isPhysical = false;
        }
      }

      // 2) Easy mode: comma-separated prefixes (used only if regex not set/invalid)
      if (!isPhysical && !rxStr) {
        const prefs = prefStr
          ? prefStr.split(",").map(s => s.trim()).filter(Boolean)
          : [];
        if (prefs.length) {
          const nUp = n.toUpperCase();
          isPhysical = prefs.some(p => nUp.startsWith(String(p).trim().toUpperCase()));
        }
      }

      // 3) Default behavior (backwards compatible)
      if (!isPhysical && !rxStr && !prefStr) {
        isPhysical =
          /^(GI|TE|TW)/.test(n) ||
          n.startsWith("SLOT") ||
          /^switch\.(gi|te|tw)\d+_\d+_\d+$/i.test(id);
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

  _colorFor(st) {
    if ((this._config?.color_mode || "state") === "speed") {
      // Speed buckets (Mbps): unknown/other => gray, 10 => red, 100 => orange, 1000 => green, 10000 => blue
      const mbps = this._parseSpeedMbps(st?.attributes);
      if (mbps === 10) return "#ef4444";      // 10M
      if (mbps === 100) return "#f59e0b";     // 100M
      if (mbps === 1000) return "#22c55e";    // 1G
      if (mbps === 2500) return "#14b8a6";    // 2.5G (teal)
      if (mbps === 5000) return "#0ea5e9";    // 5G (cyan)
      if (mbps === 10000) return "#3b82f6";   // 10G
      if (mbps === 20000) return "#6366f1";   // 20G
      if (mbps === 25000) return "#8b5cf6";   // 25G
      if (mbps === 40000) return "#a855f7";   // 40G
      if (mbps === 50000) return "#d946ef";   // 50G
      if (mbps === 100000) return "#ec4899";  // 100G
      return "#9ca3af";
          }

    // Default: represent port state via Admin/Oper
    const a = String(st.attributes?.Admin || "").toLowerCase();
    const o = String(st.attributes?.Oper || "").toLowerCase();
    if (a === "down") return "#f59e0b";
    if (a === "up" && o === "up") return "#22c55e";
    if (a === "up" && o === "down") return "#ef4444";
    return "#9ca3af";
  }

  _parseSpeedMbps(attrs) {
    // Accepts common attribute names and formats.
    // Returns exact bucket values (10/100/1000/10000) or null for unknown.
    if (!attrs) return null;
    const raw =
      attrs.Speed ?? attrs.speed ?? attrs.ifSpeed ?? attrs.if_speed ??
      attrs.PortSpeed ?? attrs.port_speed ?? attrs.link_speed ?? attrs.LinkSpeed;

    if (raw == null) return null;

    // Numeric: could be Mbps, bps, or occasionally kbps.
    if (typeof raw === "number" && Number.isFinite(raw)) {
      const v = raw;
      // Heuristic: if >= 1,000,000 treat as bps; else treat as Mbps.
      const mbps = (v >= 1_000_000) ? Math.round(v / 1_000_000) : Math.round(v);
      return this._speedBucket(mbps);
    }

    const s = String(raw).trim().toLowerCase();
    if (!s) return null;

    // Common text forms: "10M", "100 Mbps", "1G", "10G", "1000", "1 gbps", etc.
    // Normalize separators.
    const norm = s.replace(/\s+/g, "");

    // Fast path for explicit G/M tokens.
    if (/(^|\D)10g($|\D)/.test(norm) || /10gbps/.test(norm) || /10000m/.test(norm)) return 10000;
    if (/(^|\D)1g($|\D)/.test(norm) || /1gbps/.test(norm) || /1000m/.test(norm)) return 1000;
    if (/(^|\D)100m($|\D)/.test(norm) || /100mbps/.test(norm)) return 100;
    if (/(^|\D)10m($|\D)/.test(norm) || /10mbps/.test(norm)) return 10;

    // Pure numeric string.
    const num = Number(norm);
    if (Number.isFinite(num)) {
      // Same heuristic as above.
      const mbps = (num >= 1_000_000) ? Math.round(num / 1_000_000) : Math.round(num);
      return this._speedBucket(mbps);
    }

    return null;
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

  async _openBandwidthGraphDialog(title, rxEntityId, txEntityId, force = false) {
    if (!this._hass || !rxEntityId || !txEntityId) return;

    // Bandwidth entities update frequently. If we allow the main card to
    // re-render while this modal is open, the statistics-graph element gets
    // torn down/re-attached repeatedly which looks like the lines are
    // constantly redrawing. Freeze the main render loop until the user closes
    // the graph (or explicitly presses Refresh).
    this._freezeRenderWhileGraphOpen = true;

    // Remove any prior graph modal
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
          <button class="btn" data-refresh-graph="1">Refresh</button>
          <button class="btn subtle" data-close-graph="1">Close</button>
        </div>
      </div>
    `;

    const style = document.createElement("style");
    // Keep this scoped to the graph modal only.
    style.textContent = `
      .ssm-graph-modal-root{z-index:12000;}
      .ssm-graph-modal-root .ssm-modal{z-index:12001;}
      .ssm-graph-host{min-height:260px;}
      .ssm-graph-host > *{width:100%;}
    `;

    document.body.appendChild(style);
    this.shadowRoot.appendChild(root);

    this._graphModalEl = root;
    this._graphModalStyle = style;

    const close = () => {
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
    // Reuse existing graph card unless explicitly refreshed
    if (!force && this._graphCardEl) {
      host.textContent = "";
      host.appendChild(this._graphCardEl);
      return;
    }
    try {
      const helpers = await window.loadCardHelpers?.();
      if (!helpers) throw new Error("card helpers unavailable");
      // Use the same (built-in) Statistics Graph card config you showed.
      const card = helpers.createCardElement({
        type: "statistics-graph",
        chart_type: "line",
        period: "5minute",
        entities: [
          { entity: rxEntityId },
          { entity: txEntityId },
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
    this._modalEl.innerHTML = `
      <div class="ssm-backdrop"></div>
      <div class="ssm-modal" role="dialog" aria-modal="true">
        <div class="ssm-modal-title">${name}</div>
        <div class="ssm-modal-body">
          <div><b>Admin:</b> ${attrs.Admin ?? "-"}</div>
          <div><b>Oper:</b> ${attrs.Oper ?? "-"}</div>
          <div><b>Speed:</b> ${speed ?? "-"}</div>
          ${hasRates ? `<div><b>RX:</b> ${rxRate} <span class="hint">(${rxTotS})</span></div>` : ``}
          ${hasRates ? `<div><b>TX:</b> ${txRate} <span class="hint">(${txTotS})</span></div>` : ``}
          <div><b>VLAN ID:</b> ${vlan ?? "-"}</div>
          ${ip}
          <div><b>Index:</b> ${attrs.Index ?? "-"}</div>
          <div>
            <b>Alias:</b>
            <span class="alias-text">${aliasValue || "-"}</span>
            <button class="btn small" data-alias-edit="${entity_id}">Edit</button>
          </div>
        </div>
        <div class="ssm-modal-actions">
          <button class="btn wide" data-entity="${entity_id}">${this._buttonLabel(st)}</button>
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
    // Persist calibration between re-renders / card re-instantiation (e.g. in the UI editor preview)
    // Key is scoped per device prefix + card title + background image (so different models/images don't collide).
    const prefix = this._inferDevicePrefix() || "unknown";
    const title = String(this._config?.title || "");
    const bg = String(this._config?.background_image || "");
    return `ssm_calib_v1:${prefix}:${title}:${bg}`;
  }

  _loadCalibMapFromStorage() {
    try {
      const key = this._calibStorageKey();
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      return (obj && typeof obj === "object") ? obj : null;
    } catch (e) {
      return null;
    }
  }

  _persistCalibMapToStorage() {
    try {
      const key = this._calibStorageKey();
      const obj = (this._calibMap && typeof this._calibMap === "object") ? this._calibMap : {};
      localStorage.setItem(key, JSON.stringify(obj));
    } catch (e) {}
  }

  _persistCalibMapDebounced() {
    clearTimeout(this._calibPersistT);
    this._calibPersistT = setTimeout(() => this._persistCalibMapToStorage(), 150);
  }

  _setupCalibrationUI() {
    const enabled = !!this._config?.calibration_mode;
    // Clear any prior calibration state when disabled
    if (!enabled) {
      this._calibSelected = null;
      this._calibMap = null;
      this._freezeRenderWhileCalibrationActive = false;
      return;
    }

    const root = this.shadowRoot;
    const svg = root?.querySelector("svg[data-ssm-panel]");
    if (!svg) return;

    // Freeze re-renders from hass churn while calibration mode is active.
    // Similar to the graph/modal fix: rebuilding the shadow DOM resets the textarea scroll
    // and can cancel pointer capture mid-drag.
    this._freezeRenderWhileCalibrationActive = true;

    // Init map from config once, then keep it across renders while calibration mode is enabled.
    // Otherwise any hass state refresh (or periodic re-render) will "snap" ports back to their
    // original grid positions.
    if (!this._calibMap) {
      // Prefer persisted (localStorage) calibration map first so positions don't snap back
      // if Lovelace re-instantiates the card (common in the UI editor preview).
      const stored = this._loadCalibMapFromStorage();
      if (stored) {
        this._calibMap = stored;
      } else {
        const raw = (this._config.port_positions && typeof this._config.port_positions === "object") ? this._config.port_positions : {};
        this._calibMap = JSON.parse(JSON.stringify(raw || {}));
      }
    }
    this._calibSelected = this._calibSelected || null;

    const elSelected = root.getElementById("ssm-calib-selected");
    const elXY = root.getElementById("ssm-calib-xy");
    const elJson = root.getElementById("ssm-calib-json");
    const crossV = root.getElementById("ssm-calib-cross-v");
    const crossH = root.getElementById("ssm-calib-cross-h");

    const applyPortXY = (g, x, y) => {
      const rect = g?.querySelector?.("rect");
      if (rect) {
        rect.setAttribute("x", String(x));
        rect.setAttribute("y", String(y));
      }
      const label = g?.querySelector?.("text.label");
      if (label) {
        const Ps = (Number.isFinite(this._config?.port_size) ? this._config.port_size : 18) * (Number.isFinite(this._config?.ports_scale) ? this._config.ports_scale : 1);
        label.setAttribute("x", String(x + Ps / 2));
        label.setAttribute("y", String(y + Ps + (Number.isFinite(this._config?.label_size) ? this._config.label_size : 8)));
      }
    };

    const refreshJson = () => {
      if (elJson) {
        // Updating textarea.value resets scroll; preserve user scroll position unless they're already at bottom.
        const prevTop = elJson.scrollTop;
        const prevHeight = elJson.scrollHeight;
        const atBottom = (prevTop + elJson.clientHeight) >= (prevHeight - 8);

        elJson.value = Object.keys(this._calibMap || {}).length
          ? JSON.stringify(this._calibMap, null, 2)
          : "";

        // Restore scroll
        if (atBottom) {
          elJson.scrollTop = elJson.scrollHeight;
        } else {
          elJson.scrollTop = prevTop;
        }
      }
      if (elSelected) elSelected.textContent = this._calibSelected || "(click a port)";
    };
    refreshJson();

    // Clicking a port selects it (no modal) + supports drag & drop positioning
    root.querySelectorAll(".port-svg[data-entity]").forEach(g => {
      if (g._ssmCalibBound) return;
      g._ssmCalibBound = true;

      let dragging = false;
      let dragPointerId = null;
      let dragDx = 0;
      let dragDy = 0;

      let winMove = null;
      let winEnd = null;

      const onDragMove = (ev) => {
        if (!dragging || dragPointerId !== ev.pointerId) return;
        ev.preventDefault();
        const pt = this._svgPoint(svg, ev.clientX, ev.clientY);
        updateCrosshair(pt);
        if (!pt || !this._calibSelected) return;

        const nx = Math.round(pt.x - dragDx);
        const ny = Math.round(pt.y - dragDy);

        this._calibMap = this._calibMap || {};
        this._calibMap[this._calibSelected] = { x: nx, y: ny };
        applyPortXY(g, nx, ny);
        // Don't rewrite the JSON textarea on every mouse move. Updating textarea.value resets
        // its scroll position and makes it impossible to read while dragging.
        this._persistCalibMapDebounced();
      };

      const endDrag = (ev) => {
        if (dragPointerId !== ev.pointerId) return;
        dragging = false;
        dragPointerId = null;
        this._freezeRenderWhileDragging = false;

        // Restore text selection/cursor
        try {
          if (this._calibPrevUserSelect !== undefined) document.body.style.userSelect = this._calibPrevUserSelect;
          if (this._calibPrevCursor !== undefined) document.body.style.cursor = this._calibPrevCursor;
        } catch (e) {}

        refreshJson();

        if (winMove) { window.removeEventListener("pointermove", winMove, true); winMove = null; }
        if (winEnd) {
          window.removeEventListener("pointerup", winEnd, true);
          window.removeEventListener("pointercancel", winEnd, true);
          winEnd = null;
        }

        try { svg.releasePointerCapture(ev.pointerId); } catch (e) {}
        try { g.releasePointerCapture(ev.pointerId); } catch (e) {}
      };

      const getPortKey = () => {
        const title = g.querySelector("title")?.textContent || "";
        const name = g.getAttribute("data-portname") || title.split(" • ").slice(-1)[0] || "";
        return String(name || "").trim();
      };

      const getCurrentXY = () => {
        const rect = g.querySelector("rect");
        const x = rect ? Number(rect.getAttribute("x")) : NaN;
        const y = rect ? Number(rect.getAttribute("y")) : NaN;
        return {
          x: Number.isFinite(x) ? x : 0,
          y: Number.isFinite(y) ? y : 0,
        };
      };

      const selectPort = () => {
        this._calibSelected = getPortKey();
        root.querySelectorAll(".port-svg").forEach(x => x.classList.remove("calib-selected"));
        g.classList.add("calib-selected");
        refreshJson();
      };

      g.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        selectPort();

        // Mirror the prior modal/graph interaction fix: prevent text selection and keep a stable
        // pointer interaction while dragging.
        try {
          this._calibPrevUserSelect = document.body.style.userSelect;
          this._calibPrevCursor = document.body.style.cursor;
          document.body.style.userSelect = "none";
          document.body.style.cursor = "grabbing";
        } catch (e) {}

        // Prevent Lovelace/state churn from re-rendering during an active drag (causes the drag to 'drop')
        this._freezeRenderWhileDragging = true;

        // Start dragging immediately; this feels natural for DnD positioning
        const pt = this._svgPoint(svg, ev.clientX, ev.clientY);
        if (!pt) { this._freezeRenderWhileDragging = false; return; }
        const cur = getCurrentXY();
        dragging = true;
        dragPointerId = ev.pointerId;
        dragDx = pt.x - cur.x;
        dragDy = pt.y - cur.y;
        try { g.setPointerCapture(ev.pointerId); } catch (e) {}
        try { svg.setPointerCapture(ev.pointerId); } catch (e) {}

        // Attach window-level handlers to keep dragging smooth even if pointer leaves the element
        winMove = onDragMove.bind(this);
        winEnd = endDrag.bind(this);
        window.addEventListener("pointermove", winMove, true);
        window.addEventListener("pointerup", winEnd, true);
        window.addEventListener("pointercancel", winEnd, true);
      }, { passive: false });
    });

    const updateCrosshair = (pt) => {
      if (!pt) return;
      if (crossV) { crossV.setAttribute("x1", pt.x); crossV.setAttribute("x2", pt.x); }
      if (crossH) { crossH.setAttribute("y1", pt.y); crossH.setAttribute("y2", pt.y); }
      if (elXY) elXY.textContent = `${Math.round(pt.x)}, ${Math.round(pt.y)}`;
    };

    // Pointer move / click on background to set selected port's position
    const hit = root.getElementById("ssm-calib-hit");
    if (hit && !hit._ssmBound) {
      hit._ssmBound = true;
      hit.addEventListener("pointermove", (ev) => {
        const pt = this._svgPoint(svg, ev.clientX, ev.clientY);
        updateCrosshair(pt);
      }, { passive: true });

      hit.addEventListener("pointerdown", (ev) => {
        const pt = this._svgPoint(svg, ev.clientX, ev.clientY);
        updateCrosshair(pt);
        if (!pt || !this._calibSelected) return;

        // Set top-left coords for the selected port
        this._calibMap = this._calibMap || {};
        this._calibMap[this._calibSelected] = { x: Math.round(pt.x), y: Math.round(pt.y) };
        refreshJson();
        this._persistCalibMapDebounced();
      }, { passive: true });
    }

    // Buttons
    root.getElementById("ssm-calib-copy-json")?.addEventListener("click", () => {
      const txt = elJson?.value || "";
      if (txt) this._copyToClipboard(txt);
    });
    root.getElementById("ssm-calib-copy-entry")?.addEventListener("click", () => {
      if (!this._calibSelected) return;
      const entry = this._calibMap?.[this._calibSelected];
      if (!entry) return;
      this._copyToClipboard(JSON.stringify({ [this._calibSelected]: entry }, null, 2));
    });
    root.getElementById("ssm-calib-clear")?.addEventListener("click", () => {
      this._calibMap = {};
      this._calibSelected = null;
      root.querySelectorAll(".port-svg").forEach(x => x.classList.remove("calib-selected"));
      refreshJson();
      this._persistCalibMapDebounced();
    });
  }


  async _render() {
    if (!this.shadowRoot || !this._config || !this._hass) return;

    const data = await this._discoverEntities(); if (!data) return;
    const { phys, virt, diag } = data;

    const style = `
      :host { display:block; }
      ha-card { display:block; }
      .head { font-size: 18px; font-weight: 600; padding: 12px 16px; border-bottom: 1px solid var(--divider-color); }
      .section { padding: 12px 16px; }
      .hint { opacity:.85; }
      .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(170px,1fr)); gap:10px; }
      .port { border:1px solid var(--divider-color); border-radius:12px; padding:10px; background:var(--card-background-color); }
      .name { font-weight:700; margin-bottom:6px; cursor:pointer; }
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
      .label { font-size: ${this._config.label_size}px; fill: var(--primary-text-color); opacity:.85; }
      .panel-wrap { border-radius:12px; border:1px solid var(--divider-color);
        /* Prefer HA theme vars; fall back to card background for themes that don't set --ha-card-background */
        padding:6; background: color-mix(in oklab, var(--ha-card-background, var(--card-background-color, #1f2937)) 75%, transparent); }
      .panel-wrap.bg { background-repeat:no-repeat; background-position:center; background-size:contain; }

      .port-svg.calib-selected rect { stroke: rgba(255,255,255,.9); stroke-width: 2; }
      .calib-tools{ margin:12px 16px 16px 16px; padding:12px; border:1px dashed var(--divider-color); border-radius:12px; background:rgba(0,0,0,.12); }
      .calib-row{ display:flex; justify-content:space-between; align-items:baseline; gap:12px; flex-wrap:wrap; }
      .calib-title{ font-weight:700; }
      .calib-status{ font-size:12px; color:var(--secondary-text-color); }
      .calib-hint{ margin-top:6px; font-size:12px; color:var(--secondary-text-color); }
      #ssm-calib-json{ width:100%; margin-top:10px; font-family:var(--code-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace);
        font-size:12px; padding:10px; border-radius:10px; border:1px solid var(--divider-color); background:var(--card-background-color); color:var(--primary-text-color); box-sizing:border-box;
        height: 220px; overflow:auto; overscroll-behavior: contain; }
      .calib-actions{ display:flex; gap:8px; justify-content:flex-end; margin-top:10px; flex-wrap:wrap; }

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
        const rows = virt.map(([id, st]) => {
          const a = st.attributes || {};
          const n = a.Name || id.split(".")[1] || id;
          const ip = a.IP ? ` — ${a.IP}` : "";
          const alias = a.Alias;
          const titleParts = [];
          if (alias) titleParts.push(`Alias: ${alias}`);
          titleParts.push(`${n}${ip}`);
          const title = titleParts.join(" • ");
          return `<div class="virt-row" title="${title}">
            <span class="dot" style="background:${this._colorFor(st)}"></span>
            <span class="virt-name" data-alias-entity="${id}">${n}${ip}</span>
            <button class="btn" data-entity="${id}">${this._buttonLabel(st)}</button>
          </div>`;
        }).join("");
        return `<div class="box"><div class="virt-title">Virtual Interfaces</div>${rows}</div>`;
      })();

      if (!diagBox && !virtBox) return "";
      return `<div class="info-grid">${diagBox}${virtBox}</div>`;
    })();

    const listView = () => {
      const grid = phys.map(([id, st]) => {
        const a = st.attributes || {};
        const name = a.Name || id.split(".")[1];
        const ip = a.IP ? ` • IP: ${a.IP}` : "";
        const alias = a.Alias;
        const titleParts = [];
        if (alias) titleParts.push(`Alias: ${alias}`);
        titleParts.push(`${name}${ip}`);
        const title = titleParts.join(" • ");
        return `<div class="port" title="${title}">
          <div class="name" data-alias-entity="${id}">${name}</div>
          <div class="kv"><span class="dot" style="background:${this._colorFor(st)}"></span>
            Admin: ${a.Admin ?? "-"} • Oper: ${a.Oper ?? "-"}${ip}
          </div>
          <button class="btn wide" data-entity="${id}">${this._buttonLabel(st)}</button>
        </div>`;
      }).join("");

      return `
        ${this._config.info_position === "above" ? infoGrid : ""}
        <div class="section">
          ${phys.length ? `<div class="grid">${grid}</div>` : `<div class="hint">No physical ports discovered.</div>`}
        </div>
        ${this._config.info_position === "below" ? infoGrid : ""}`;
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
      const G = this._config.gap;
      const perRow = Math.max(1, this._config.ports_per_row);
      const rows = Math.max(1, Math.ceil((panelPorts.length || perRow) / perRow));
      const W = this._config.panel_width;
      const topPad = 24, sidePad = 28, rowPad = (this._config.show_labels ? (this._config.label_size + 14) : 18);
      const H = 20 + topPad + rows * (P + G) + rowPad;
      const plate = useBg ? "" : `<rect x="10" y="10" width="${W - 20}" height="${H - 20}" rx="8"
        fill="var(--ha-card-background, var(--card-background-color, #1f2937))" stroke="var(--divider-color, #4b5563)"/>`;

const usableW = W - 2 * sidePad, slotW = usableW / perRow;

      // Optional per-port positioning overrides (panel view)
      // Map keys are interface Names (e.g. "Gi1/0/1"). Matching is case-insensitive.
      // When calibration mode is enabled we may have a live (in-memory) map that differs from
      // config.port_positions. Use the live map so drag/drop doesn't snap back on refresh.
      const portPosRaw = (this._config.calibration_mode && this._calibMap && typeof this._calibMap === "object")
        ? this._calibMap
        : ((this._config.port_positions && typeof this._config.port_positions === "object")
            ? this._config.port_positions
            : null);
      const portPos = portPosRaw
        ? new Map(Object.entries(portPosRaw).map(([k, v]) => [String(k).trim().toLowerCase(), v]))
        : null;

      const rects = panelPorts.map(([id, st], i) => {
        const a = st.attributes || {};
        const name = String(a.Name || id.split(".")[1] || "");
        const alias = a.Alias;
        const idx = i % perRow, row = Math.floor(i / perRow);
        let x = sidePad + idx * slotW + (slotW - P) / 2;
        let y = topPad + row * (P + G) + 18;

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
        const label = this._config.show_labels
          ? `<text class="label" x="${x + Ps / 2}" y="${y + Ps + this._config.label_size}" text-anchor="middle">${name}</text>`
          : "";
        const titleParts = [];
        if (alias) titleParts.push(`Alias: ${alias}`);
        titleParts.push(name);
        const title = this._htmlEscape(titleParts.join(" • "));
        return `
          <g class="port-svg" data-entity="${id}" data-portname="${this._htmlEscape(name)}" tabindex="0" style="cursor:pointer">
            <title>${title}</title>
            <rect x="${x}" y="${y}" width="${Ps}" height="${Ps}" rx="${Math.round(Ps * 0.2)}"
              fill="${fill}" stroke="rgba(0,0,0,.35)"/>
            ${label}
          </g>`;
      }).join("");

      const svg = `
        <div class="panel-wrap${useBg ? " bg" : ""}"${useBg ? ` style="background-image:url(${bgUrl})"` : ""}>
          <svg data-ssm-panel="1" viewBox="0 0 ${W} ${H}" width="100%" height="auto" preserveAspectRatio="xMidYMid meet">

            ${this._config.calibration_mode ? `
              <!-- Background hit-target must be BEHIND ports so port dragging/selection works -->
              <rect id="ssm-calib-hit" x="0" y="0" width="${W}" height="${H}" fill="rgba(0,0,0,0.001)" style="pointer-events:all"></rect>
            ` : ``}

            ${plate}
            ${rects}
            ${this._config.calibration_mode ? `
              <g id="ssm-calib-layer" style="pointer-events:none">
                <line id="ssm-calib-cross-v" x1="0" y1="0" x2="0" y2="${H}" stroke="rgba(255,255,255,.35)" stroke-width="1"></line>
                <line id="ssm-calib-cross-h" x1="0" y1="0" x2="${W}" y2="0" stroke="rgba(255,255,255,.35)" stroke-width="1"></line>
              </g>
            ` : ``}
          </svg>
        </div>`;

      return `
        ${this._config.info_position === "above" ? infoGrid : ""}
        <div class="panel">${svg}</div>
        ${this._config.calibration_mode ? `
          <div class="calib-tools">
            <div class="calib-row">
              <div class="calib-title">Calibration mode</div>
              <div class="calib-status">Selected: <span id="ssm-calib-selected">(click a port)</span> • Cursor: <span id="ssm-calib-xy">-</span></div>
            </div>
            <div class="calib-hint">
              1) Drag and drop ports to the desired positions  2) Copy JSON and paste into <b>Port positions</b> box in <b>Settings</b>
            </div>
            <textarea id="ssm-calib-json" rows="8" readonly></textarea>
            <div class="calib-actions">
              <button class="btn" id="ssm-calib-copy-entry" type="button">Copy selected entry</button>
              <button class="btn" id="ssm-calib-copy-json" type="button">Copy full JSON</button>
              <button class="btn subtle" id="ssm-calib-clear" type="button">Clear</button>
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
        if (this._config?.calibration_mode) return; // handled by calibration helper
        this._openDialog(id);
      });
      g.addEventListener("keypress", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          const id = g.getAttribute("data-entity");
          if (!id) return;
          if (this._config?.calibration_mode) return; // handled by calibration helper
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
      }

      set hass(hass) {
        // Keep hass (editor API) but avoid re-rendering on every state change,
        // which causes the <select> dropdown to collapse while the user is interacting.
        const first = !this._hasHass;
        this._hass = hass;
        this._hasHass = true;

        // Only load device list once per editor instance.
        if (first) {
          this._loadSnmpDevices();
        }

        // Render once when we have both hass and config.
        if (this._hasConfig && !this._rendered) {
          this._render();
          this._rendered = true;
        }
      }

      setConfig(config) {
        this._config = { ...config };
        this._hasConfig = true;
        // Re-render when config changes (YAML/editor), but avoid frequent re-renders from hass updates.
        this._rendered = false;
        if (this._hasHass) {
          this._render();
          this._rendered = true;
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

      result.push({ id, name, prefix });
    }

    result.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    this._snmpDevices = result;
  } catch (err) {
    // If anything fails, keep an empty list (but do not break the card/editor).
    // eslint-disable-next-line no-console
    console.warn("SNMP Switch Manager Card: failed to load devices", err);
    this._snmpDevices = [];
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

      _render() {
        if (!this.shadowRoot) return;
        const c = this._config || {};
        const devices = Array.isArray(this._snmpDevices) ? this._snmpDevices : [];
        const deviceOptions = devices.map(d => {
          const sel = String(c.device || "") === String(d.prefix) ? " selected" : "";
          return `<option value="${this._escape(d.prefix)}"${sel}>${this._escape(d.name)}</option>`;
        }).join("");

        const portsText = Array.isArray(c.ports)
          ? c.ports.join("\n")
          : (typeof c.ports === "string" ? c.ports : "");

        this.shadowRoot.innerHTML = `
          <style>
            .form {
              display: flex;
              flex-direction: column;
              gap: 12px;
              padding: 8px 4px 12px;
            }
            .row {
              display: flex;
              flex-direction: column;
              gap: 4px;
            }
            .row.inline {
              flex-direction: row;
              align-items: center;
              justify-content: space-between;
            }
            label {
              font-size: 13px;
              font-weight: 500;
            }
            input[type="text"],
            input[type="number"],
            select,
            textarea {
              width: 100%;
              box-sizing: border-box;
            }
            textarea {
              min-height: 72px;
              resize: vertical;
            }
            .two-col {
              display: grid;
              grid-template-columns: repeat(2, minmax(0,1fr));
              gap: 8px;
            }
            .hint {
              font-size: 12px;
              opacity: 0.8;
            }
          
            .diaglist { display:flex; flex-direction:column; gap:6px; width:100%; }
            .diagitem { display:flex; align-items:center; justify-content:space-between; border:1px solid var(--divider-color); border-radius:6px; padding:6px 8px; }
            .diagname { font-size: 14px; }
            .diagbtns { display:flex; gap:6px; }
            .diagbtns button { cursor:pointer; padding:2px 8px; border:1px solid var(--divider-color); border-radius:6px; background: var(--card-background-color); color: var(--primary-text-color); }
</style>
          <div class="form">
            <div class="row">
              <label for="title">Title</label>
              <input id="title" type="text" value="${this._escape(c.title || "")}">
            </div>

            <div class="two-col">
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
            </div>

            <div class="row">
              <label for="color_mode">Port colors</label>
              <select id="color_mode">
                <option value="state"${(c.color_mode !== "speed") ? " selected" : ""}>State (Admin/Oper)</option>
                <option value="speed"${(c.color_mode === "speed") ? " selected" : ""}>Speed</option>
              </select>
              <div class="hint">Choose whether port colors represent port state or link speed.</div>
            </div>


<div class="row">
  <label for="device">Switch device</label>
  <select id="device">
    <option value="">Select a device…</option>
    ${deviceOptions}
  </select>
  <div class="hint">Select a SNMP Switch Manager device (derived from entity ID prefixes).</div>
</div>

<div class="two-col">
  <div class="row">
    <label for="physical_prefixes">Physical interface prefixes (comma-separated)</label>
    <input id="physical_prefixes" type="text" placeholder="Gi,Te,Tw,Fa,Ge,Eth,Po,Port,SLOT" value="${c.physical_prefixes != null ? this._escape(String(c.physical_prefixes)) : ""}">
    <div class="hint">Interfaces whose <b>Name</b> starts with any prefix are treated as <b>Physical</b>. All others are treated as <b>Virtual</b>.</div>
  </div>
  <div class="row">
    <label for="physical_regex">Physical interface regex (optional override)</label>
    <input id="physical_regex" type="text" placeholder="^(Gi|Te|Tw|Fa|Ge|Eth|Po|Port|SLOT)" value="${c.physical_regex != null ? this._escape(String(c.physical_regex)) : ""}">
    <div class="hint">If set, this regex (case-insensitive) determines which interfaces are <b>Physical</b>. Prefix list is ignored when regex is provided.</div>
  </div>
</div>

            </div>
            <div class="two-col">
              <div class="row">
                <label for="ports_per_row">Ports per row (panel)</label>
                <input id="ports_per_row" type="number" min="1" value="${c.ports_per_row != null ? Number(c.ports_per_row) : 24}">
              </div>
              <div class="row">
                <label for="panel_width">Panel width</label>
                <input id="panel_width" type="number" min="200" value="${c.panel_width != null ? Number(c.panel_width) : 740}">
              </div>
            </div>

            <div class="two-col">
              <div class="row">
                <label for="port_size">Port size</label>
                <input id="port_size" type="number" min="8" value="${c.port_size != null ? Number(c.port_size) : 18}">
              </div>
              <div class="row">
                <label for="gap">Port gap</label>
                <input id="gap" type="number" min="0" value="${c.gap != null ? Number(c.gap) : 10}">
              </div>
            </div>

            <div class="row inline">
              <label for="show_labels">Show labels under ports</label>
              <input id="show_labels" type="checkbox"${c.show_labels !== false ? " checked" : ""}>
            </div>

            <div class="row inline">
              <label for="hide_diagnostics">Hide Diagnostics panel</label>
              <input id="hide_diagnostics" type="checkbox"${c.hide_diagnostics ? " checked" : ""}>
            </div>

            <div class="row inline">
              <label for="hide_virtual_interfaces">Hide Virtual Interfaces panel</label>
              <input id="hide_virtual_interfaces" type="checkbox"${c.hide_virtual_interfaces ? " checked" : ""}>
            </div>

            
            <div class="row">
              <label for="background_image">Panel background image (optional)</label>
              <input id="background_image" type="text" placeholder="/local/your_switch.png" value="${c.background_image != null ? this._escape(c.background_image) : ""}">
            </div>

            <div class="row two">
              <div>
                <label for="ports_offset_x">Ports offset X (px)</label>
                <input id="ports_offset_x" type="number" value="${c.ports_offset_x != null ? Number(c.ports_offset_x) : 0}">
              </div>
              <div>
                <label for="ports_offset_y">Ports offset Y (px)</label>
                <input id="ports_offset_y" type="number" value="${c.ports_offset_y != null ? Number(c.ports_offset_y) : 0}">
              </div>
            </div>

            <div class="row">
              <label for="ports_scale">Ports scale</label>
              <input id="ports_scale" type="number" step="0.05" min="0.1" value="${c.ports_scale != null ? Number(c.ports_scale) : 1}">
            </div>

            <div class="row">
              <label for="port_positions">Port positions (optional JSON map)</label>
              <textarea id="port_positions" rows="6" placeholder='{"Gi1/0/1":{"x":20,"y":40}}'>${c.port_positions ? this._escape(JSON.stringify(c.port_positions)) : ""}</textarea>
              <div class="hint">Keys are interface Names; values are SVG x/y coords. Leave blank to use the grid layout.</div>
            </div>

            <div class="row inline">
              <label for="calibration_mode">Calibration mode (click-to-generate Port positions JSON)</label>
              <input id="calibration_mode" type="checkbox"${c.calibration_mode ? " checked" : ""}>
            </div>

<div class="row">
              <label for="label_size">Label font size</label>
              <input id="label_size" type="number" min="6" value="${c.label_size != null ? Number(c.label_size) : 8}">
            </div>

            <div class="row">
              <label for="ports">Explicit ports (optional)</label>
              <textarea
                id="ports"
                placeholder="switch.gi1_0_1\nswitch.gi1_0_2"
              >${this._escape(portsText)}</textarea>
              <div class="hint">One entity ID per line. If set, only these switch entities will be shown (auto-discovery is skipped).</div>
            </div>

            <div class="row">
              <label>Diagnostics order</label>
              <div class="diaglist">
                ${(["hostname","manufacturer","model","firmware_revision","uptime"]).map((k, i) => {
                  const order = Array.isArray(c.diagnostics_order) && c.diagnostics_order.length
                    ? c.diagnostics_order
                    : ["hostname","manufacturer","model","firmware_revision","uptime"];
                  const key = order[i] || k;
                  const label = ({
                    hostname: "Hostname",
                    manufacturer: "Manufacturer",
                    model: "Model",
                    firmware_revision: "Firmware Revision",
                    uptime: "Uptime"
                  })[key] || key;
                  return `
                    <div class="diagitem">
                      <span class="diagname">${this._escape(label)}</span>
                      <div class="diagbtns">
                        <button class="diagup" data-idx="${i}" title="Move up">▲</button>
                        <button class="diagdown" data-idx="${i}" title="Move down">▼</button>
                      </div>
                    </div>
                  `;
                }).join("")}
              </div>
              <div class="hint">Diagnostics sensors are discovered automatically for the selected device (Hostname, Manufacturer, Model, Firmware Revision, Uptime). Use the arrows to reorder.</div>
            </div>
          </div>
        `;

        const root = this.shadowRoot;

        // Title
        root.getElementById("title")?.addEventListener("input", (ev) => {
          this._updateConfig("title", ev.target.value);
        });

        // View
        root.getElementById("view")?.addEventListener("change", (ev) => {
          this._updateConfig("view", ev.target.value || "panel");
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


// Switch device
root.getElementById("device")?.addEventListener("change", (ev) => {
  const val = String(ev.target.value || "").trim();
  this._updateConfig("device", val || null);
});

        // Physical interface classification (panel/list)
        // Use "change" (commit-on-blur/enter) instead of "input" to avoid the HA
        // visual editor re-rendering on every keystroke (which causes focus loss).
        root.getElementById("physical_prefixes")?.addEventListener("change", (ev) => {
          const val = String(ev.target.value || "");
          this._updateConfig("physical_prefixes", val.trim() ? val : null);
        });
        root.getElementById("physical_regex")?.addEventListener("change", (ev) => {
          const val = String(ev.target.value || "");
          this._updateConfig("physical_regex", val.trim() ? val : null);
        });

        // Ports per row
        root.getElementById("ports_per_row")?.addEventListener("change", (ev) => {
          const v = parseInt(ev.target.value, 10);
          this._updateConfig("ports_per_row", Number.isFinite(v) ? v : 24);
        });

        // Panel width
        root.getElementById("panel_width")?.addEventListener("change", (ev) => {
          const v = parseInt(ev.target.value, 10);
          this._updateConfig("panel_width", Number.isFinite(v) ? v : 740);
        });

        // Port size
        root.getElementById("port_size")?.addEventListener("change", (ev) => {
          const v = parseInt(ev.target.value, 10);
          this._updateConfig("port_size", Number.isFinite(v) ? v : 18);
        });

        // Gap
        root.getElementById("gap")?.addEventListener("change", (ev) => {
          const v = parseInt(ev.target.value, 10);
          this._updateConfig("gap", Number.isFinite(v) ? v : 10);
        });

        // Show labels
        root.getElementById("show_labels")?.addEventListener("change", (ev) => {
          this._updateConfig("show_labels", !!ev.target.checked);
        });

        // Hide panels
        root.getElementById("hide_diagnostics")?.addEventListener("change", (ev) => {
          this._updateConfig("hide_diagnostics", !!ev.target.checked);
        });
        root.getElementById("hide_virtual_interfaces")?.addEventListener("change", (ev) => {
          this._updateConfig("hide_virtual_interfaces", !!ev.target.checked);
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
        root.getElementById("ports_scale")?.addEventListener("change", (ev) => {
          const v = parseFloat(ev.target.value);
          this._updateConfig("ports_scale", (Number.isFinite(v) && v > 0) ? v : 1);
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
        });

// Label size
        root.getElementById("label_size")?.addEventListener("change", (ev) => {
          const v = parseInt(ev.target.value, 10);
          this._updateConfig("label_size", Number.isFinite(v) ? v : 8);
        });

        // Explicit ports textarea
        root.getElementById("ports")?.addEventListener("input", (ev) => {
          const text = ev.target.value || "";
          const list = text
            .split(/\r?\n/)
            .map((ln) => ln.trim())
            .filter((ln) => ln.length > 0);
          this._updateConfig("ports", list.length ? list : null);
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

// Mark as rendered so we don't re-render on subsequent hass/setConfig calls
        this._rendered = true;
      }
    }

    // Final guard in case something registered it between our initial check
    if (!customElements.get("snmp-switch-manager-card-editor")) {
      customElements.get("snmp-switch-manager-card-editor") || customElements.define("snmp-switch-manager-card-editor", SnmpSwitchManagerCardEditor);
    }
  });
}
