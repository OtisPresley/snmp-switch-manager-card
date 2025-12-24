# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] - 2025-11-20
### Initial Release

---

## [0.2.0] - 2025-12-23
### Added
- 🎚️ Support for switch port names starting with `Slot`
- 🏷️ Updated README with Home Assistant Community Store (HACS) installation instructions
- 📊 Added **Speed** and **VLAN ID** attributes to the port information pop-up
- 🖼️ Support for a **custom switch background image** in panel view
- 🎯 Ability to **reposition and scale ports** to align with a custom background image
- 👁️ Options to **individually hide** the Diagnostics panel and Virtual Interfaces panel
- 🧩 Unified port information pop-up across **panel and list views**

### Fixed
- 🧹 Removed the switch hostname prefix from Diagnostics sensor display names
- 🎨 Ensured all colors rely on Home Assistant **theme variables** for proper Light/Dark theme compatibility
- 🧩 Eliminated the need for multiple Lovelace resource URLs by embedding the editor into the main card

---
