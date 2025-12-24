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
  }

  setConfig(config) {
    this._config = {
      title: config.title ?? "",
      view: (config.view === "panel" ? "panel" : "list"),
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
      const isPhysical = /^(GI|TE|TW)/.test(n) || n.startsWith("SLOT") || /^switch\.(gi|te|tw)\d+_\d+_\d+$/i.test(id);
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
    const a = String(st.attributes?.Admin || "").toLowerCase();
    const o = String(st.attributes?.Oper || "").toLowerCase();
    if (a === "down") return "#f59e0b";
    if (a === "up" && o === "up") return "#22c55e";
    if (a === "up" && o === "down") return "#ef4444";
    return "#9ca3af";
  }

  _buttonLabel(st) {
    return (st.state || "").toLowerCase() === "on" ? "Turn off" : "Turn on";
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
      .label { font-size: ${this._config.label_size}px; fill: var(--primary-text-color); opacity:.85; }
      .panel-wrap { border-radius:12px; border:1px solid var(--divider-color);
        /* Prefer HA theme vars; fall back to card background for themes that don't set --ha-card-background */
        padding:6; background: color-mix(in oklab, var(--ha-card-background, var(--card-background-color, #1f2937)) 75%, transparent); }
      .panel-wrap.bg { background-repeat:no-repeat; background-position:center; background-size:contain; }

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

      const rects = panelPorts.map(([id, st], i) => {
        const a = st.attributes || {};
        const name = String(a.Name || id.split(".")[1] || "");
        const alias = a.Alias;
        const idx = i % perRow, row = Math.floor(i / perRow);
        const x = sidePad + idx * slotW + (slotW - P) / 2, y = topPad + row * (P + G) + 18;
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
          <g class="port-svg" data-entity="${id}" tabindex="0" style="cursor:pointer">
            <title>${title}</title>
            <rect x="${x}" y="${y}" width="${Ps}" height="${Ps}" rx="${Math.round(Ps * 0.2)}"
              fill="${fill}" stroke="rgba(0,0,0,.35)"/>
            ${label}
          </g>`;
      }).join("");

      const svg = `
        <div class="panel-wrap${useBg ? " bg" : ""}"${useBg ? ` style="background-image:url(${bgUrl})"` : ""}>
          <svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" preserveAspectRatio="xMidYMid meet">
            ${plate}
            ${rects}
          </svg>
        </div>`;

      return `
        ${this._config.info_position === "above" ? infoGrid : ""}
        <div class="panel">${svg}</div>
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
        if (id) this._openDialog(id);
      });
      g.addEventListener("keypress", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          const id = g.getAttribute("data-entity");
          if (id) this._openDialog(id);
        }
      });
    });

    // Re-attach modal AND style if they exist (so it stays styled and centered)
    if (this._modalStyle) this.shadowRoot.append(this._modalStyle);
    if (this._modalEl) this.shadowRoot.append(this._modalEl);
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
        ports_per_row: 24,
        panel_width: 740,
        port_size: 18,
        gap: 10,
        show_labels: true,
        label_size: 8,
        info_position: "above",
        hide_diagnostics: false,
        hide_virtual_interfaces: false,
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
  <label for="device">Switch device</label>
  <select id="device">
    <option value="">Select a device…</option>
    ${deviceOptions}
  </select>
  <div class="hint">Select a SNMP Switch Manager device (derived from entity ID prefixes).</div>
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


// Switch device
root.getElementById("device")?.addEventListener("change", (ev) => {
  const val = String(ev.target.value || "").trim();
  this._updateConfig("device", val || null);
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
