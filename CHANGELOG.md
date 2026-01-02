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

## [0.3.0] - 2025-12-24
### Added
- 🧭 **Device-based card configuration**
  - Card now targets a selected **SNMP Switch Manager device** instead of anchor entities or name filters
  - Device selector is populated directly from the Home Assistant **Device Registry**
- 🧠 **Automatic Diagnostics discovery**
  - Diagnostics panel now auto-discovers:
    - Hostname
    - Manufacturer
    - Model
    - Firmware Revision
    - Uptime
- 🔀 **Reorderable Diagnostics**
  - Diagnostics display order can be customized directly in the card editor
- ⚡ **Live port toggle feedback**
  - “Turn on / Turn off” button in the port popup updates immediately when port state changes

### Changed
- 🧩 **Removed legacy configuration fields**
  - `anchor_entity`, `device_name`, `unit`, and `slot` are no longer required or shown in the editor
- 🧰 **Diagnostics configuration simplified**
  - Manual `diagnostics:` lists are no longer required; discovery is automatic

### Fixed
- 🔁 **Editor stability**
  - Prevented continuous re-rendering that caused dropdowns to close unexpectedly
- 🎛️ **Popup interaction reliability**
  - Port state changes now update the popup UI without requiring it to be closed and reopened

---

## [0.3.2] - 2025-12-25
### Added
- 🎨 **Configurable port color mode**
  - New `color_mode` option allows port colors to represent either:
    - **Port State** (Admin / Oper status – default)
    - **Port Speed**
  - Mode can be switched directly from the card editor or YAML configuration

### Port Color Meanings

#### State Mode (default)
- 🟩 **Green** — Admin: Up · Oper: Up  
- 🟥 **Red** — Admin: Up · Oper: Down  
- 🟧 **Orange** — Admin: Down · Oper: Down  
- ⬜ **Gray** — Admin: Up · Oper: Not Present  

#### Speed Mode
- 🟦 **Blue** — 10 Gbps  
- 🟩 **Green** — 1 Gbps  
- 🟧 **Orange** — 100 Mbps  
- 🟥 **Red** — 10 Mbps  
- ⬜ **Gray** — Unknown / unsupported speed

### Notes
- Default behavior remains **unchanged** unless `color_mode` is explicitly set to `speed`
- No visual layout, sizing, or interaction behavior was modified

---

## [0.3.3] - 2025-12-26
### Added
- 📈 **Bandwidth history graph popup**
  - RX and TX throughput displayed together in a single statistics graph
  - Accessible directly from the port information popup
  - Uses Home Assistant’s native Statistics Graph card

- 🔄 **Manual graph refresh control**
  - Refresh button added to prevent constant redraws
  - Improves dashboard performance and visual stability

- 🎯 **Speed-based port coloring enhancements**
  - Extended Speed Color mode to support modern multi-gig and high-speed links:
    - 2.5 Gbps
    - 5 Gbps
    - 20 Gbps
    - 25 Gbps
    - 40 Gbps
    - 50 Gbps
    - 100 Gbps

- 🖼️ **Reliable panel port positioning**
  - Fixed `ports_offset_x`, `ports_offset_y`, and `port_positions` so they apply correctly
  - Enables accurate alignment of ports over custom background images

- 🧲 **Drag-and-drop port calibration (panel view)**
  - Optional calibration mode allows ports to be positioned visually
  - Positions can be copied as JSON and pasted directly into `port_positions`
  - Designed for precise alignment with real switch faceplates

### Improved
- 🧭 **Popup behavior and persistence**
  - Bandwidth graph opens in a modal popup instead of inline rendering
  - Popup remains visible and stable during Home Assistant state updates

- 🎨 **Speed color clarity**
  - Clear, visually progressive color ladder from Fast Ethernet through 100G
  - Colors remain readable in both Light and Dark themes

### Fixed
- 🐞 Port positioning settings not applying in panel view

---

## [0.3.4] - 2025-12-28
### Added
- 🧩 **Configurable Physical vs Virtual interface classification (card)**
  - New editor fields allow users to define how Physical interfaces are detected:
    - `physical_prefixes` (comma-separated prefix list)
    - `physical_regex` (optional regex override; takes precedence)
  - Interfaces that do not match are treated as **Virtual**
  - Backward compatible: if unset, existing default behavior remains

### Changed
- 🎨 **Speed color semantics (Speed mode)**
  - **Unknown / unsupported speed** now renders as **Red**
  - **10 Mbps** now renders as **Gray**

### Fixed
- 🐞 Port speed reporting unknown when SNMP reporting in bps

---

## [0.3.5-beta.1] - 2026-01-02
### 🚀 Major UI & Layout Enhancements (Beta)
This beta release introduces a significantly refined card editor experience, a modernized Layout Editor workflow, and improved interaction behavior — all designed to make switch visualization easier, more intuitive, and more powerful.

### Added
- 🧩 **Modernized Layout Editor**
  - Inline enable/disable toggle with contextual help
  - One-click **exit button** directly on the card to leave Layout Editor instantly
  - Smarter tool visibility (tools appear only when relevant)
  - Uplinks layout tool available only when enabled
- 🧠 **Context-aware editor controls**
  - Options dynamically appear or hide based on:
    - View mode (Panel vs List)
    - Enabled features (Ports, Uplinks, Diagnostics)
    - Selected color mode
- 🎨 **Improved Port Color configuration UI**
  - Compact color swatches with full-width hex input
  - Optimized layout allowing up to **4 colors per row**
  - Clearer labeling and reset behavior
- 📊 **Speed-mode traffic interaction option**
  - New option (Speed color mode only) to open the **bandwidth graph directly when clicking a port**
  - Automatically shown only when bandwidth sensors exist for the device
  - Uses the same modal popup as the Graph button in port details
- ❓ **Expanded contextual help**
  - Help icons added throughout the editor
  - Help text updated to reflect current behavior and best practices

### Improved
- 🎛️ **Device selector reliability**
  - Changing the selected switch device now immediately updates the card preview
- 🖱️ **Port interaction consistency**
  - Click behavior is consistent across Panel and List views
  - Graph popups now always open as styled modal dialogs
- 🧭 **Layout logic clarity**
  - Options that only affect layout behavior are now clearly scoped to the Layout Editor
  - Uplinks are no longer rendered separately in the card display

### Notes
- This is a **beta release** intended for early adopters.
- Existing configurations remain compatible.
- Deprecated or unused configuration options are automatically ignored to prevent editor issues.
