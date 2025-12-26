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
   <p float="left">
      <img src="https://raw.githubusercontent.com/otispresley/snmp-switch-manager/main/assets/screenshot1.png" alt="Screenshot 1" width="250"/>
   </p>

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


      
   Clicking a port opens a unified information dialog (used in both panel and list views) showing:

    - Interface name
    - Admin and Oper status
    - Speed
    - VLAN ID
    - Interface index
    
    The port power toggle updates live in the dialog as soon as the port state changes.


    <p float="left">
      <img src="https://raw.githubusercontent.com/otispresley/snmp-switch-manager/main/assets/screenshot2.png" alt="Screenshot 1" width="250"/>
      <img src="https://raw.githubusercontent.com/otispresley/snmp-switch-manager/main/assets/screenshot3.png" alt="Screenshot 2" width="250"/>
      <img src="https://raw.githubusercontent.com/otispresley/snmp-switch-manager/main/assets/screenshot4.png" alt="Screenshot 3" width="250"/>
    </p>

---

## 🎨 Port Color Legend

  Port colors can represent either **port state** or **link speed**, depending on the selected `color_mode`.
  
  ### State Mode (default)
  - 🟩 **Green** — Admin: Up · Oper: Up  
  - 🟥 **Red** — Admin: Up · Oper: Down  
  - 🟧 **Orange** — Admin: Down · Oper: Down  
  - ⬜ **Gray** — Admin: Up · Oper: Not Present  
  
  ### Speed Mode
  - 🟦 **Blue** — 10 Gbps  
  - 🟩 **Green** — 1 Gbps  
  - 🟧 **Orange** — 100 Mbps  
  - 🟥 **Red** — 10 Mbps  
  - ⬜ **Gray** — Unknown or non-standard speed  
  
  ### Example
  ```yaml
  type: custom:snmp-switch-manager-card
  device: SWITCH-BONUSCLOSET
  color_mode: speed
  ```
  
  ℹ️ If color_mode is not specified, the card defaults to state-based coloring for full backward compatibility.

---

## Support

- Open an issue on the [GitHub tracker](https://github.com/OtisPresley/snmp-switch-manager-card/issues) if you run into problems or have feature requests.
- Contributions and feedback are welcome!

If you find this integration useful and want to support development, you can:

[![Buy Me a Coffee](https://img.shields.io/badge/Support-Buy%20Me%20a%20Coffee-orange)](https://www.buymeacoffee.com/OtisPresley)
[![Donate via PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/OtisPresley)
