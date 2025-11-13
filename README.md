# SNMP Switch Manager Card: Home Assistant Plugin

[![Home Assistant](https://img.shields.io/badge/Home%20Assistant-41BDF5?logo=home-assistant&logoColor=white&style=flat)](https://www.home-assistant.io/)
[![HACS Badge](https://img.shields.io/badge/HACS-Default-41BDF5.svg)](https://hacs.xyz)
[![License: MIT](https://raw.githubusercontent.com/otispresley/snmp-switch-manager-card/main/assets/license-mit.svg)](https://github.com/OtisPresley/snmp-switch-manager-card/blob/main/LICENSE)
[![HACS](https://img.shields.io/github/actions/workflow/status/OtisPresley/snmp-switch-manager-card/hacs.yaml?branch=main&label=HACS)](https://github.com/OtisPresley/snmp-switch-manager-card/actions/workflows/hacs.yaml)

A lovelace card to be used with the [SNMP Switch Manager](https://github.com/OtisPresley/snmp-switch-manager) integration for Home Assistant.

---

## Installation and Configuration

1. Download the snmp-switch-manager-card.js file and place it in `www/community/snmp-switch-manager-card/` in Home Assistant.

2. Add the card JavaScript as a resource under **Settings → Dashboards → Resources**:

   ```yaml
   url: /local/community/snmp-switch-manager-card/snmp-switch-manager-card.js
   type: module
   ```

3. Place the card on any dashboard:

   ```yaml
    type: custom:snmp-switch-manager-card
    title: Core Switch
    view: panel
    ports_per_row: 12
    info_position: below
    label_size: 8
    anchor_entity: switch.gi1_0_1
    diagnostics:
      - sensor.hostname
      - sensor.firmware_revision
      - sensor.manufacturer
      - sensor.model
      - sensor.uptime
   ```

   The `anchor_entity` is any entity in your switch so it knows which ports and diagnostics to display.
   
   Clicking a port opens a dialog with quick actions to toggle the port or edit its description. There is also an alternative `list` view depicted in the      third image below.

    <p float="left">
      <img src="https://raw.githubusercontent.com/otispresley/snmp-switch-manager/main/assets/screenshot1.png" alt="Screenshot 1" width="260"/>
      <img src="https://raw.githubusercontent.com/otispresley/snmp-switch-manager/main/assets/screenshot2.png" alt="Screenshot 2" width="260"/>
      <img src="https://raw.githubusercontent.com/otispresley/snmp-switch-manager/main/assets/screenshot3.png" alt="Screenshot 3" width="260"/>
    </p>

---

## Support

- Open an issue on the [GitHub tracker](https://github.com/OtisPresley/snmp-switch-manager-card/issues) if you run into problems or have feature requests.
- Contributions and feedback are welcome!

If you find this integration useful and want to support development, you can:

[![Buy Me a Coffee](https://img.shields.io/badge/Support-Buy%20Me%20a%20Coffee-orange)](https://www.buymeacoffee.com/OtisPresley)
[![Donate via PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/OtisPresley)
