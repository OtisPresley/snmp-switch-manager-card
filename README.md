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
    title: ""
    view: panel
    color_mode: state
    ports_per_row: 24
    panel_width: 940
    gap: 10
    show_labels: false
    label_size: 6
    info_position: below
    hide_diagnostics: false
    hide_virtual_interfaces: false
    calibration_mode: false
    device: switch_study
    background_image: /local/images/N1108P-ON_front_black.png
    port_positions:
      Gi1/0/1:
        x: 386.4295959472656
        "y": 24.34100341796875
      Gi1/0/2:
        x: 386.4295959472656
        "y": 55.947601318359375
      Gi1/0/3:
        x: 422.4835205078125
        "y": 24.34100341796875
      Gi1/0/4:
        x: 422.4835205078125
        "y": 55.947601318359375
      Gi1/0/5:
        x: 458.5374450683594
        "y": 24.34100341796875
      Gi1/0/6:
        x: 458.5374450683594
        "y": 55.947601318359375
      Gi1/0/7:
        x: 494.59136962890625
        "y": 24.34100341796875
      Gi1/0/8:
        x: 494.59136962890625
        "y": 55.947601318359375
      Gi1/0/10:
        x: 543.7317199707031
        "y": 55.947601318359375
      Gi1/0/9:
        x: 543.7317199707031
        "y": 24.34100341796875
      Gi1/0/11:
        x: 591.5968017578125
        "y": 20.962440490722656
      Gi1/0/12:
        x: 591.5968017578125
        "y": 59.34493637084961
    state_colors:
      up_up: "#118d3c"
      up_down: "#9c3030"
      down_down: "#9d6606"
    port_scale: 1.2
    label_bg_color: "#050505"
    label_numbers_only: false
    virtual_overrides: []
    show_uplinks_separately: false
    uplink_ports:
      - Gi1/0/9
      - Gi1/0/10
      - Gi1/0/11
      - Gi1/0/12
    speed_click_opens_graph: false
    hide_ports: []
   ```
  
  ### Configuration Options
  The following are descriptions of the settings:
  
  #### Core
  - `title` — Card title text.
  - `view` — `panel` (switch face) or `list` (rows/tiles).
  - `device` — **Preferred** device selector (Device Registry entry id/slug used by the card).
  - `device_name` — **Legacy** device selector (kept for compatibility; prefer `device`).
  - `color_mode` — `state` (default) or `speed`.
  
  #### Panel layout (panel view)
  - `ports_per_row` — Number of ports per row.
  - `panel_width` — Panel width in pixels.
  - `port_size` — Port icon size.
  - `gap` — Spacing between ports.
  - `ports_scale` — Uniform scaling factor for ports.
  - `port_scale` — **Alias** for `ports_scale` (compatibility).
  - `background_image` — Background image URL (panel view).
  - `port_positions` — Per-port `{x,y}` overrides (often generated by Layout Editor).
  - `calibration_mode` — Enables the Layout Editor (panel view).
  
  #### Labels (panel view)
  - `show_labels` — Show/hide labels under ports.
  - `label_size` — Label font size.
  - `label_numbers_only` — Show only the numeric portion of labels.
  - `label_color` — Override label text color.
  - `label_bg_color` — Override label background color (panel view only).
  
  #### Sections & visibility
  - `info_position` — `above` or `below` (Diagnostics/Virtual Interfaces relative to ports).
  - `hide_diagnostics` — Hide diagnostics panel.
  - `hide_virtual_interfaces` — Hide virtual interfaces panel.
  - `hide_ports` — Hide specific ports (list or YAML array of port names).
  
  #### Diagnostics
  - `diagnostics_order` — Order of discovered diagnostics (e.g., hostname, manufacturer…).
  - `diagnostics_enabled` — Enable/disable individual diagnostics by key.
  - `diagnostics` — **Legacy** manual sensor list (compatibility; discovery is preferred).
  
  #### Physical vs virtual classification
  - `physical_prefixes` — Comma-separated prefixes treated as Physical.
  - `physical_regex` — Optional regex override (takes precedence).
  - `virtual_overrides` — Explicit list of interfaces to treat as virtual.
  
  #### Uplinks (layout behavior only)
  - `show_uplinks_separately` — Enables uplink handling **in Layout Editor only**.
  - `uplink_ports` — List of uplink ports (used by Layout Editor / Smart Assist).
  
  #### Speed-mode click behavior
  - `speed_click_opens_graph` — When `color_mode: speed` and bandwidth sensors exist, clicking a port opens the bandwidth graph first.
  
  #### Color overrides
  - `state_colors` — Override colors used in state mode (e.g., `up_up`, `up_down`, `down_down`, etc.).
  - `speed_colors` — Override colors used in speed mode (keys like `10 Mbps`, `100 Mbps`, `Unknown`, etc.).

      
   Clicking a port opens a unified information dialog (used in both panel and list views) showing:

  - Interface name
  - Admin and Oper status
  - RX and TX throughput and cumulative
  - Speed
  - VLAN ID / Trunk information
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

**Example using vertical stack card showing the switch ports duplicated with the first row showing port state colors and the second row showing port speed colors.** Thanks to [@larieu](https://github.com/larieu) for contributing this.
 <table>
    <tr>
      <td align="center">
        <img src="https://raw.githubusercontent.com/otispresley/snmp-switch-manager/main/assets/screenshot16.png" width="250">
      </td>
    </tr>
  </table>

**24 port switch:**
```yaml
  type: vertical-stack
  cards:
    - type: custom:snmp-switch-manager-card
      title: ""
      view: panel
      color_mode: state
      ports_per_row: 24
      panel_width: 1480
      port_size: 36
      gap: 10
      show_labels: false
      label_size: 8
      info_position: below
      hide_diagnostics: true
      hide_virtual_interfaces: true
      calibration_mode: false
      device: gs1900_24ep
      ports_scale: 1.5
    - type: custom:snmp-switch-manager-card
      title: ""
      view: panel
      color_mode: speed
      ports_per_row: 24
      panel_width: 1480
      port_size: 36
      gap: 10
      show_labels: true
      label_size: 24
      info_position: below
      hide_diagnostics: false
      hide_virtual_interfaces: true
      calibration_mode: false
      device: gs1900_24ep
      ports_scale: 1.5
  title: SNMP Switch 24
  grid_options:
    columns: 24
    rows: auto
```

**8 port switch:**
```yaml
  type: vertical-stack
  cards:
    - type: custom:snmp-switch-manager-card
      title: ""
      view: panel
      color_mode: state
      ports_per_row: 8
      panel_width: 740
      port_size: 36
      gap: 10
      show_labels: false
      label_size: 8
      info_position: below
      hide_diagnostics: true
      hide_virtual_interfaces: true
      calibration_mode: false
      device: gs1900_8hp_01
      ports_scale: 1.5
    - type: custom:snmp-switch-manager-card
      title: ""
      view: panel
      color_mode: speed
      ports_per_row: 8
      panel_width: 740
      port_size: 36
      gap: 10
      show_labels: true
      label_size: 24
      info_position: below
      hide_diagnostics: false
      hide_virtual_interfaces: true
      calibration_mode: false
      device: gs1900_8hp_01
      ports_scale: 1.5
title: SNMP Switch 08 - 01
```

---

## 🧩 Layout Editor (Panel View)

The SNMP Switch Manager Card includes a built-in **Layout Editor** designed to make aligning ports with real switch faceplates fast and intuitive.

### What it does
- Enables **visual drag-and-drop positioning** of ports
- Supports precise alignment over custom background images
- Eliminates trial-and-error placement using raw coordinates

### How to use
1. Enable **Layout Editor** in the card editor
2. Use the on-card tools to:
   - Move ports
   - Adjust scale and offsets
   - Define port grouping and order
3. When finished, click the **close (✕) button** on the card to exit Layout Editor instantly
4. Save the card configuration to persist changes

> ℹ️ Layout Editor controls only affect layout behavior and do not change port data or device state.

### Generated configuration
The Layout Editor produces standard configuration values such as:

```yaml
ports_scale: 1
port_positions:
  Gi1/0/1: { x: 120, y: 80 }
  Gi1/0/2: { x: 150, y: 80 }
```

### ❌ What was removed (and should NOT appear anywhere)
The following options are **no longer used** and should not be documented:

- `ports_offset_x`
- `ports_offset_y`

Alignment and positioning are now handled entirely through:
- `ports_scale`
- `port_positions`
- Layout Editor interactions

This keeps the configuration simpler and avoids confusion or save-time validation issues.

---

## 🔍 Sanity check (we’re good)
- CHANGELOG entry **does not mention** these fields ✅
- Layout Editor description remains accurate ✅
- No backward-compat confusion introduced ✅

If you want, next we can:
- Do a **final README consistency sweep** (only what exists in the editor)
- Or prepare a **clean migration note** for users upgrading from ≤0.3.4

You’re in great shape for **v0.3.5-beta.1** 🚀

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

## ❓ Contextual Help

Most editor options include a **help icon** providing detailed explanations and usage guidance.
These hints adapt based on the current view and enabled features, helping keep the interface clean while still offering advanced control when needed.

---

## 🧠 Performance Notes

- The history graph does **not auto-refresh** continuously
- A manual refresh button is provided to:
  - Improve dashboard performance
  - Avoid flickering or unpredictable redraw behavior
- This mirrors the behavior of a standalone Statistics Graph card while keeping the UI lightweight

---

## 🎨 Port Color Legend

  Port colors can represent either **port state** or **link speed**, depending on the selected `color_mode`. The colors represented are the default. You can set your own custom colors in the card configuration.
  
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
