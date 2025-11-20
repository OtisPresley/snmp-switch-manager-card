// snmp-switch-manager-card-editor.js
// GUI editor for snmp-switch-manager-card, kept separate so the card
// itself remains untouched and safe.

customElements.whenDefined("snmp-switch-manager-card").then(() => {
  const CardClass = customElements.get("snmp-switch-manager-card");

  // Tell Home Assistant how to get the editor + a stub config
  CardClass.getConfigElement = () => {
    return document.createElement("snmp-switch-manager-card-editor");
  };

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
  });

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
      // We keep hass so we match the editor API, even though we
      // no longer use HA's internal picker components.
      this._hass = hass;
      this._hasHass = true;
      if (this._hasConfig && !this._rendered) {
        this._render();
      }
    }

    setConfig(config) {
      this._config = { ...config };
      this._hasConfig = true;
      if (this._hasHass && !this._rendered) {
        this._render();
      }
    }

    // ---- helpers ----
    _escape(str) {
      if (str == null) return "";
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
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

      const portsText = Array.isArray(c.ports)
        ? c.ports.join("\n")
        : (typeof c.ports === "string" ? c.ports : "");

      const diagText = Array.isArray(c.diagnostics)
        ? c.diagnostics.join("\n")
        : (typeof c.diagnostics === "string" ? c.diagnostics : "");

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
            <label for="anchor_entity">Anchor entity (switch.* on target device)</label>
            <input
              id="anchor_entity"
              type="text"
              placeholder="switch.gi1_0_1"
              value="${this._escape(c.anchor_entity || "")}"
            >
            <div class="hint">Used to scope auto-discovery to a specific switch device.</div>
          </div>

          <div class="two-col">
            <div class="row">
              <label for="device_name">Device name filter (optional)</label>
              <input id="device_name" type="text" value="${this._escape(c.device_name || "")}">
            </div>
            <div class="row">
              <label>Unit / Slot (optional)</label>
              <div class="two-col">
                <input id="unit" type="number" placeholder="Unit" value="${c.unit != null ? Number(c.unit) : ""}">
                <input id="slot" type="number" placeholder="Slot" value="${c.slot != null ? Number(c.slot) : ""}">
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
            <label for="diagnostics">Diagnostics sensors (optional)</label>
            <textarea
              id="diagnostics"
              placeholder="sensor.hostname\nsensor.model"
            >${this._escape(diagText)}</textarea>
            <div class="hint">One sensor entity ID per line, in display order.</div>
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

      // Anchor entity
      root.getElementById("anchor_entity")?.addEventListener("input", (ev) => {
        const val = ev.target.value.trim();
        this._updateConfig("anchor_entity", val || null);
      });

      // Device name
      root.getElementById("device_name")?.addEventListener("input", (ev) => {
        const val = ev.target.value.trim();
        this._updateConfig("device_name", val || null);
      });

      // Unit / Slot
      root.getElementById("unit")?.addEventListener("change", (ev) => {
        const v = parseInt(ev.target.value, 10);
        this._updateConfig("unit", Number.isFinite(v) ? v : null);
      });
      root.getElementById("slot")?.addEventListener("change", (ev) => {
        const v = parseInt(ev.target.value, 10);
        this._updateConfig("slot", Number.isFinite(v) ? v : null);
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

      // Diagnostics textarea
      root.getElementById("diagnostics")?.addEventListener("input", (ev) => {
        const text = ev.target.value || "";
        const list = text
          .split(/\r?\n/)
          .map((ln) => ln.trim())
          .filter((ln) => ln.length > 0);
        this._updateConfig("diagnostics", list);
      });

      // Mark as rendered so we don't re-render on subsequent hass/setConfig calls
      this._rendered = true;
    }
  }

  customElements.define(
    "snmp-switch-manager-card-editor",
    SnmpSwitchManagerCardEditor,
  );
});
