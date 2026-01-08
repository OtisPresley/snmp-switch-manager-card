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

## Documentation

Comprehensive documentation for **SNMP Switch Manager** is available
in the GitHub Wiki.

The Wiki includes:
- Installation and configuration guidance
- Attributes vs Sensors explained
- Diagnostics and PoE behavior
- Lovelace card usage and customization
- Supported switches and limitations
- Troubleshooting and FAQ

👉 **Read the full documentation:**  
https://github.com/OtisPresley/snmp-switch-manager/wiki

---

## Support

- Open an issue on the [GitHub tracker](https://github.com/OtisPresley/snmp-switch-manager-card/issues) if you run into problems or have feature requests.
- Contributions and feedback are welcome!

If you find this integration useful and want to support development, you can:

[![Buy Me a Coffee](https://img.shields.io/badge/Support-Buy%20Me%20a%20Coffee-orange)](https://www.buymeacoffee.com/OtisPresley)
[![Donate via PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/OtisPresley)
