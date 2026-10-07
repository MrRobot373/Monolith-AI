---
name: mobile-app
description: "Use when building or changing a mobile app (React Native/Expo, Flutter, native): screens, navigation, offline data, permissions, release."
category: Software development
---

# Mobile app development

## Identify the stack

`package.json` with `expo`/`react-native` → React Native; `pubspec.yaml` → Flutter; `*.xcodeproj` /
`build.gradle` → native. Follow the existing navigation, state and styling libraries. Simulators
aren't available here: rely on type checks, linters, unit/widget tests and careful reading.

## Screens and navigation

- List screens and the navigation graph (tabs, stacks, modals) first.
- Each screen: loading, empty, error, offline, and success states.
- React Native: React Navigation (or expo-router) typed routes; Flutter: `go_router` or Navigator 2.0.
- Deep links for screens people share or reach from notifications.

## Platform conventions

- Respect safe areas (notches, home indicator), dynamic type/font scaling, dark mode.
- Touch targets ≥ 44×44 pt (iOS) / 48×48 dp (Android); native-feeling back behavior on Android.
- Keyboard: avoid covering inputs (`KeyboardAvoidingView` / `Scaffold(resizeToAvoidBottomInset)`).
- Accessibility labels on icons and images (`accessibilityLabel` / `Semantics`).

## Data and offline

- One API client with timeouts, retries for idempotent requests, and auth token refresh.
- Cache server data (TanStack Query / Riverpod / Bloc); show cached data while refreshing.
- Queue writes when offline if the product needs it; resolve conflicts explicitly.
- Store secrets/tokens in secure storage (Keychain/Keystore: `expo-secure-store`,
  `flutter_secure_storage`), never in plain AsyncStorage/SharedPreferences.

## Permissions

Ask at the moment of need with a clear reason; handle "denied" and "denied forever" (link to
settings); add usage descriptions (`NSCameraUsageDescription`, Android manifest permissions).

## Performance

Virtualized lists (`FlatList`/`FlashList`, `ListView.builder`), image caching and sizing, avoid heavy
work on the UI thread, memoize list items, measure startup time.

## Quality checks

- React Native: `npx tsc --noEmit`, `npm run lint`, `npm test` (Jest + Testing Library).
- Flutter: `flutter analyze`, `flutter test` (if the SDK is installed).
- Read through changed screens for all states and platform differences (`Platform.OS` /
  `Theme.of(context).platform`).

## Release preparation

App icon and splash, version/build numbers bumped, permissions descriptions, privacy details for the
store listings (data collected), crash reporting configured, environment config for production,
release notes. Store submission itself happens outside this environment.

## Done when

Screens handle all states, platform conventions and accessibility are respected, secure storage is
used for secrets, checks/tests pass, and you listed what must be verified on a device.
