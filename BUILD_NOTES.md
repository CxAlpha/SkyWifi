# Build notes

The workflow uses OpenWrt 25.12.5's apk-tools 3.x.

Important: `apk info --file PACKAGE.apk` is invalid syntax for apk-tools 3.x.
The workflow validates generated APKs with `apk manifest PACKAGE.apk` and
`apk --allow-untrusted verify PACKAGE.apk` instead.

The package itself is still created with the OpenWrt-compatible `apk mkpkg`
flow (`--info`, `--script`, `--files`, `--output`, and optional `--sign`).

## Fixed build notes
- Portal defaults OFF; first install remains accessible through normal LuCI.
- Portal ON/OFF is applied through a deterministic service restart.
- Portal listener uses the Sky Wifi CGI as index/404 handler, so `:8080` does not open LuCI.
- HTTP requests from unauthorized clients are redirected to the voucher portal; router LAN IP remains excluded.
- A device record alone never grants Internet access; its currently assigned voucher must be ACTIVE and unexpired.
- Voucher revoke immediately removes the device IP from the authorization set.
- Expired/revoked devices cannot keep existing forwarded sessions through the captive-portal filter.
- Admin Panel includes password protection, portal control, device list, details, block/unblock and forget/delete.


## SkyWifi 2.2.0 acceptance changes
- Voucher Name and Mobile are optional; Voucher Code is the only activation requirement.
- Portal state is controlled through one UCI-backed backend action and verified after restart.
- Admin and Voucher Manager expose separate Enable/Disable actions and read the same backend state.
- Reset SkyWifi clears SkyWifi-owned data/runtime state and leaves OpenWrt/LuCI/WAN/LAN/Wi-Fi configuration intact.
- GitHub Actions builds against OpenWrt 25.12.5 ramips/mt7621, matching Archer C6 v3.2.
- Static validation is performed in CI; router runtime acceptance still requires a physical Archer C6 v3.2 test.
