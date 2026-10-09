# Tambay-AI

On-device seat-detection camera app. VisionCamera frame processor -> resize
plugin -> TFLite (SSD MobileNet) inference -> Skia bounding-box overlay, plus a
small telemetry dashboard. All vision inference runs on-device; only a ~100-byte
JSON count payload is POSTed to the sync endpoint.

## Prerequisites

- Node.js LTS and npm
- A physical Android or iOS device (no emulator/simulator needed for dev)
- EAS CLI for builds: `npm i -g eas-cli` (or use `npx eas-cli@latest`)
- An Expo account with access to the `axonee` org (for EAS builds)

**Expo Go does not work with this project.** It uses native modules
(react-native-vision-camera, react-native-fast-tflite, Nitro modules, Skia)
that are not bundled in Expo Go. You must use a development build.

## Clone and install

```bash
git clone https://github.com/Aaarl24/Tambayan-AI.git
cd Tambayan-AI
npm ci
```

Optional: create a `.env` file (gitignored) to override defaults:

```bash
EXPO_PUBLIC_BRANCH_NAME=Taft Ave
EXPO_PUBLIC_SYNC_URL=http://<your-pc-ip>:3000/sync
```

## Install the development build

1. Build once on EAS (requires the `axonee` Expo account):
   ```bash
   npx eas-cli build --profile development --platform android
   npx eas-cli build --profile development --platform ios
   ```
2. Android: open the build link from `eas build` output (or
   https://expo.dev/accounts/axonee/projects/tambay-ai/builds) on the device and
   install the APK.
3. iOS: register the device first (`npx eas-cli device:create`), then install
   via the build link. Developer Mode must be enabled on the device
   (Settings -> Privacy & Security -> Developer Mode).

## Run the app

```bash
npx expo start --dev-client
```

Then open the "Tambay-AI" dev client on the device and select the dev server.
If the device is not on the same Wi-Fi network:

```bash
npx expo start --dev-client --tunnel
```

## Native vs JS changes

Some changes only need `git pull` + a Metro reload; others need a **new EAS
build and a reinstall** on every device.

Needs a new native build:
- `app.json` native keys: `ios.bundleIdentifier`, `android.package`,
  permissions, `ios.infoPlist`
- Config plugin options (`react-native-vision-camera`, `react-native-fast-tflite`,
  `expo-build-properties`, e.g. `minSdkVersion`, `usesCleartextTraffic`)
- Adding/upgrading a package with native code
- `eas.json` profile changes (affect the next build only)

JS-only (no rebuild):
- `App.tsx`, `src/**` code changes
- `.env` `EXPO_PUBLIC_*` values
- `babel.config.js`, `tailwind.config.js`, `metro.config.js`, styles

## Verification

```bash
npx tsc --noEmit
npx expo install --check
npx expo-doctor
```
