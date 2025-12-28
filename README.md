# SNMP Switch Manager Card: Home Assistant Plugin

[![Home Assistant](https://img.shields.io/badge/Home%20Assistant-41BDF5?logo=home-assistant&logoColor=white&style=flat)](https://www.home-assistant.io/)
[![HACS Badge](https://img.shields.io/badge/HACS-Default-41BDF5.svg)](https://hacs.xyz)
[![Stars](https://img.shields.io/github/stars/OtisPresley/snmp-switch-manager-card?label=Stars&color=41BDF5)](https://github.com/OtisPresley/snmp-switch-manager-card/stargazers)
[![License: MIT](https://raw.githubusercontent.com/otispresley/snmp-switch-manager-card/main/assets/license-mit.svg)](https://github.com/OtisPresley/snmp-switch-manager-card/blob/main/LICENSE)
[![HACS](https://img.shields.io/github/actions/workflow/status/OtisPresley/snmp-switch-manager-card/hacs.yaml?branch=main&label=HACS)](https://github.com/OtisPresley/snmp-switch-manager-card/actions/workflows/hacs.yaml)

A lovelace card to be used with the [SNMP Switch Manager](https://github.com/OtisPresley/snmp-switch-manager) integration for Home Assistant.

---

## Installation

### HACS (recommended)

You can install this card directly from HACS:

[![Open your Home Assistant instance and show the repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=OtisPresley&repository=snmp-switch-manager-card)

🚫 **No manual resource configuration is required.**

This card includes its editor automatically, so you do **not** need to add any additional JavaScript resources under  
**Settings → Dashboards → Resources**.

After installation, restart Home Assistant. The card will then be available as:

**Custom: SNMP Switch Manager Card**

---

### 🔁 Migrating from Manual to HACS Installation (Important)

If you previously installed this card manually using resource URLs, follow these steps to safely migrate to the HACS-managed version:

1. 🗑️ **Remove old resources** from  
   **Settings → Dashboards → Resources**
   - Remove:
     ```
     /local/community/snmp-switch-manager-card/snmp-switch-manager-card.js
     ```
     ```
     /local/community/snmp-switch-manager-card/snmp-switch-manager-card-editor.js
     ```

2. 📂 **Delete the old manually installed files** from: `/config/www/community/snmp-switch-manager-card/`
3. ✅ **Install the card via HACS** using the HACS button above.

4. 🔄 **Restart Home Assistant**

Once complete, everything will be fully managed by HACS and you will continue to receive automatic updates.

---

### Manual installation

1. Download the `snmp-switch-manager-card.js` file and place it in Home Assistant here:
`/config/www/community/snmp-switch-manager-card/`

2. Add **only one** JavaScript resource under  
**Settings → Dashboards → Resources**:

   ```yaml
   url: /local/community/snmp-switch-manager-card/snmp-switch-manager-card.js
   type: module
   ```
   ⚠️ Do NOT add a separate editor resource. The editor is embedded in the card.
   
---

## Configuration

1. Place the card on any dashboard and edit via the GUI or in YAML:

  <table>
    <tr>
      <td align="center">
        <img src="https://raw.githubusercontent.com/otispresley/snmp-switch-manager/main/assets/screenshot1.png" width="250">
      </td>
    </tr>
  </table>

   ```yaml
    type: custom:snmp-switch-manager-card
    type: custom:snmp-switch-manager-card
    title: Core Switch
    view: panel
    
    # Select the SNMP Switch Manager device
    device: SWITCH-BONUSCLOSET
    
    ports_per_row: 24
    info_position: below
    label_size: 6
    port_size: 18
    gap: 10
    
    # Optional display controls
    hide_diagnostics: false
    hide_virtual_interfaces: false

    # Optional Physical vs Virtual interface classification
    # (If unset, the card uses its built-in defaults)
    physical_prefixes: "Gi,Te,Tw,Fa,Ge,Eth,Po,Port,SLOT"
    # physical_regex: "^(Gi|Te|Tw|Fa|Ge|Eth|Port|Po|SLOT)"

    # Optional panel background image (panel view only)
    background_image: /local/switches/core-switch.png
    ports_offset_x: 0
    ports_offset_y: 0
    ports_scale: 1
    
    # Optional per-port positioning overrides
    port_positions:
      Gi1/0/1: { x: 120, y: 80 }
      Gi1/0/2: { x: 150, y: 80 }
   ```

   The follows are descriptions of the settings:
   - `title` sets the text displayed at the tip of the card.
   - `view` sets the style that the card uses. `list` lists each port in a tile. `panel` show a representation of the front of a switch.
   - `ports_per_row` sets the number of ports to show in each row on the card when in panel view.
   - `panel width` The total width of the card in pixels when in panel view.
   - `info_position` displays the Diagnostics and Virtual Interfaces either `above` the phisical ports or `below` them.
   - `label_size` determines the font size used for the port labels when in panel view.
   - `port_size` determines the size of the port images when in panel view.
   - `gap` determines how far apart the ports are when in panel view.
   - `hide_diagnostics` hides the Diagnostics panel entirely when set to `true`.
   - `hide_virtual_interfaces` hides the Virtual Interfaces panel entirely when set to `true`.
   - `background_image` sets a custom switch image for panel view.
   - `ports_offset_x` and `ports_offset_y` move all ports to align with the background image.
   - `ports_scale` scales all ports uniformly.
   - `port_positions` allows individual ports to be positioned manually.
   - `device` selects the SNMP Switch Manager device from Home Assistant’s Device Registry.
     - Diagnostics are automatically discovered (Hostname, Manufacturer, Model, Firmware Revision, Uptime).
     - Diagnostics order can be customized directly in the card editor.
   - `color_mode` controls how port colors are interpreted:
     - `state` (default): colors reflect Admin / Oper status
     - `speed`: colors reflect negotiated link speed
   - `physical_prefixes` controls which interfaces are treated as **Physical** (everything else becomes **Virtual**).
     - Comma-separated list of interface name prefixes (case-insensitive)
     - Example: `Gi,Te,Tw,Fa,Ge,Eth,Po,Port,SLOT`
   - `physical_regex` (optional) overrides `physical_prefixes`.
     - Regular expression applied to the interface name (case-insensitive)
     - Example: `^(Gi|Te|Tw|Fa|Ge|Eth|Port|Po|SLOT)`


      
   Clicking a port opens a unified information dialog (used in both panel and list views) showing:

  - Interface name
  - Admin and Oper status
  - RX and TX throughput and cumulative
  - Speed
  - VLAN ID
  - Interface index
  - Turn on/off button
  - Graph button
  
  The port power toggle updates live in the dialog as soon as the port state changes.

  <table>
    <tr>
      <td align="center">
        <img src="https://raw.githubusercontent.com/otispresley/snmp-switch-manager/main/assets/screenshot2.png" width="250">
      </td>
      <td align="center">
        <img src="https://raw.githubusercontent.com/otispresley/snmp-switch-manager/main/assets/screenshot3.png" width="250">
      </td>
      <td align="center">
        <img src="https://raw.githubusercontent.com/otispresley/snmp-switch-manager/main/assets/screenshot4.png" width="250">
      </td>
    </tr>
    <tr>
      <td align="center">
        <img src="https://raw.githubusercontent.com/otispresley/snmp-switch-manager/main/assets/screenshot13.png" width="250">
      </td>
      <td align="center">
        <img src="https://raw.githubusercontent.com/otispresley/snmp-switch-manager/main/assets/screenshot14.png" width="250">
      </td>
      <td align="center">
        <img src="https://raw.githubusercontent.com/otispresley/snmp-switch-manager/main/assets/screenshot15.png" width="250">
      </td>
    </tr>
  </table>

---

## 🧲 Drag-and-Drop Port Calibration (Panel View)

When using **panel view** with a custom switch background image, the card provides an optional
**drag-and-drop calibration mode** to make aligning ports fast and intuitive.

### What it does
- Allows ports to be **visually repositioned** by dragging them directly on the card
- Designed to precisely align ports with **real switch faceplates**
- Eliminates trial-and-error guessing of `x/y` coordinates

### How it works
1. Enable **Calibration Mode** in the card editor
2. Drag ports into their desired positions on the background image
3. Copy the generated **`port_positions` JSON**
4. Paste it into the card configuration
5. Disable Calibration Mode when finished

The generated positions use the same structure as manual configuration:

```yaml
port_positions:
  Gi1/0/1: { x: 120, y: 80 }
  Gi1/0/2: { x: 150, y: 80 }
```

## 📈 Bandwidth Monitoring & History Graphs

When **Bandwidth Sensors** are enabled in the **SNMP Switch Manager integration**, the Switch Manager card automatically enhances the port popup with real-time throughput data and historical graphs.

### What’s included
- **RX and TX throughput values** displayed directly in the port popup
- 📊 **History graph button** per interface
- RX and TX plotted together in a single statistics graph
- Uses Home Assistant’s native **Statistics Graph** card

### Popup behavior
- The bandwidth graph opens in a **modal popup**
- Includes a **manual refresh button**
- Prevents constant redraws and unnecessary re-renders
- Popup remains visible until explicitly closed by the user

### Conditional display
The bandwidth section is shown **only when all conditions are met**:
- Bandwidth Sensors are enabled for the device
- The interface has valid RX and TX sensor entities
- Sensor values are numeric and available

Interfaces without bandwidth sensors remain unchanged and do not show empty fields or inactive controls.

> ℹ️ No additional card configuration is required.  
> The card automatically detects and uses the bandwidth sensors created by the integration.

---

## 🧠 Performance Notes

- The history graph does **not auto-refresh** continuously
- A manual refresh button is provided to:
  - Improve dashboard performance
  - Avoid flickering or unpredictable redraw behavior
- This mirrors the behavior of a standalone Statistics Graph card while keeping the UI lightweight

---

## 🎨 Port Color Legend

  Port colors can represent either **port state** or **link speed**, depending on the selected `color_mode`.
  
  ### State Mode (default)
  - 🟩 **Green** — Admin: Up · Oper: Up  
  - 🟥 **Red** — Admin: Up · Oper: Down  
  - 🟧 **Orange** — Admin: Down · Oper: Down  
  - ⬜ **Gray** — Admin: Up · Oper: Not Present  
  
  ### Speed Mode

  When `color_mode: speed` is enabled, port colors represent the negotiated link speed:
  
  - <img src="https://singlecolorimage.com/get/9ca3af/18x18" width="18" height="18" style="vertical-align:middle" /> **Gray** — 10 Mbps
  - <img src="https://singlecolorimage.com/get/f59e0b/18x18" width="18" height="18" style="vertical-align:middle" /> **Orange** — 100 Mbps
  - <img src="https://singlecolorimage.com/get/22c55e/18x18" width="18" height="18" style="vertical-align:middle" /> **Green** — 1 Gbps
  - <img src="https://singlecolorimage.com/get/14b8a6/18x18" width="18" height="18" style="vertical-align:middle" /> **Teal** — 2.5 Gbps
  - <img src="https://singlecolorimage.com/get/0ea5e9/18x18" width="18" height="18" style="vertical-align:middle" /> **Cyan** — 5 Gbps
  - <img src="https://singlecolorimage.com/get/3b82f6/18x18" width="18" height="18" style="vertical-align:middle" /> **Blue** — 10 Gbps
  - <img src="https://singlecolorimage.com/get/6366f1/18x18" width="18" height="18" style="vertical-align:middle" /> **Indigo** — 20 Gbps
  - <img src="https://singlecolorimage.com/get/8b5cf6/18x18" width="18" height="18" style="vertical-align:middle" /> **Violet** — 25 Gbps
  - <img src="https://singlecolorimage.com/get/a855f7/18x18" width="18" height="18" style="vertical-align:middle" /> **Purple** — 40 Gbps
  - <img src="https://singlecolorimage.com/get/d946ef/18x18" width="18" height="18" style="vertical-align:middle" /> **Fuchsia** — 50 Gbps
  - <img src="https://singlecolorimage.com/get/ec4899/18x18" width="18" height="18" style="vertical-align:middle" /> **Pink** — 100 Gbps
  - <img src="https://singlecolorimage.com/get/ef4444/18x18" width="18" height="18" style="vertical-align:middle" /> **Red** — Unknown or unsupported speed

  > ℹ️ Speed values are automatically parsed from SNMP attributes and normalized.
  > The card supports both numeric (e.g. `2500`, `100000`) and textual
  > representations (e.g. `2.5G`, `25Gbps`, `100G`).

  ### Example
  ```yaml
  type: custom:snmp-switch-manager-card
  device: SWITCH-BONUSCLOSET
  color_mode: speed
  ```
  
  > ℹ️ If color_mode is not specified, the card defaults to state-based coloring for full backward compatibility.

---

## Support

- Open an issue on the [GitHub tracker](https://github.com/OtisPresley/snmp-switch-manager-card/issues) if you run into problems or have feature requests.
- Contributions and feedback are welcome!

If you find this integration useful and want to support development, you can:

[![Buy Me a Coffee](https://img.shields.io/badge/Support-Buy%20Me%20a%20Coffee-orange)](https://www.buymeacoffee.com/OtisPresley)
[![Donate via PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/OtisPresley)
