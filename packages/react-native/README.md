# @dalathappyfarm/postbox-react-native

In-app feedback with an automatic screenshot and attached photos (library or camera) for React Native and Expo apps.
It sends to a Postbox server (`POST {endpoint}/api/submit`).

```text
 +-------------------+  POST /api/submit  +--------------+     +-----------+
 | Your app          |  note, screenshot, | Your Postbox |     | Dashboard |
 |  FeedbackProvider |------------------->| server       |---->| (you)     |
 |  shake or button  |  photos, key       +--------------+     +-----------+
 +-------------------+
```

## Install

```sh
npm install @dalathappyfarm/postbox-react-native
npx expo install expo-application expo-device expo-secure-store expo-sensors expo-image-picker expo-image-manipulator expo-file-system react-native-view-shot
```

Peer dependencies: `react`, `react-native`, `expo-application`, `expo-device`, `expo-secure-store`, `expo-sensors`, `expo-image-picker`, `expo-image-manipulator`, `expo-file-system`, `react-native-view-shot`.
`expo-secure-store` stores the consent flag and the install id; it ships with the Expo SDK, so it adds no community native module (AsyncStorage would).
These are native modules, so make a new dev client or EAS build after installing.

## Setup

Add the camera usage string in the host app (iOS refuses the camera without it; the library picker needs no permission):

```json
["expo-image-picker", { "cameraPermission": "Allow $(PRODUCT_NAME) to use the camera so you can attach a photo to your feedback." }]
```

Put that in the `plugins` array of `app.json`, then rebuild the dev client.
The camera permission is asked only when the user taps Camera; if denied, the sheet shows one line pointing to Settings.

```tsx
import { FeedbackProvider, useFeedback } from "@dalathappyfarm/postbox-react-native";

export default function Root() {
  return (
    <FeedbackProvider
      endpoint="https://your-postbox.pages.dev"
      projectKey={process.env.EXPO_PUBLIC_POSTBOX_KEY!}
      getScreen={() => currentRouteName()}
      showButton={isTestBuild}
      shake={isTestBuild}
    >
      <App />
    </FeedbackProvider>
  );
}

// anywhere below the provider, for example a Settings row
const { open } = useFeedback();
<Button title="Send feedback" onPress={() => open("idea")} />;
```

## Props

| Prop | Type | Notes |
|---|---|---|
| `endpoint` | string | Postbox base URL, no trailing path |
| `projectKey` | string | Public key, sent as `X-Project-Key` |
| `getScreen` | `() => string` | Read when the sheet opens; sent as `screen` |
| `showButton` | boolean | Round floating button for testers, see "Floating button" below |
| `buttonPosition` | `{ side: "left" \| "right"; y: number }` | Where the button starts; `y` is points from the top of the window to the top of the 44 pt touch box |
| `buttonBottom` | number | Deprecated, use `buttonPosition`; still honoured as the initial distance from the bottom edge, docked right |
| `insets` | `{ top?, right?, bottom?, left? }` | Safe-area insets in points; keeps the button clear of the notch and home indicator |
| `shake` | boolean | Opens the sheet on shake (accelerometer above 2.2 g, 2 s cooldown) |
| `strings` | `Partial<Strings>` | Override any UI text (English defaults) |
| `onError` | `(error: string) => void` | Capture or send failures, for logging |

`useFeedback().open(kind?)` opens the sheet with `bug`, `idea` or `other` preselected.
Keep `showButton` and `shake` off in store builds if you do not want testers' tools there.

## Floating button

The button is for testers, so it must never block the app under test.
It is a round 44 pt touch target (a 40 pt circle with a chat-bubble icon, slightly translucent at rest, label "Send feedback" for screen readers).
It starts docked to the right edge at about 62% of the window height, clear of top navigation and of primary buttons near the bottom.

- Tap opens the sheet. A drag never does.
- Drag it anywhere. On release it snaps to the nearest left or right edge and stays inside the safe area.
- The position is kept for the session and stored with `expo-secure-store`, so it survives restarts. A stored position wins over `buttonPosition`.
- Long press hides it for the session.
- It steps aside while the keyboard is up, so it never covers a bar the app pins above the keyboard (a Done button, for example).

Pass the safe-area insets so the button also keeps clear of the notch and the home indicator.
Without `insets` the kit assumes typical system bars.

```tsx
import { initialWindowMetrics } from "react-native-safe-area-context";

<FeedbackProvider showButton={isTestBuild} insets={initialWindowMetrics?.insets} buttonPosition={{ side: "left", y: 400 }} ... />
```

The icon is drawn with plain Views and the kit does not depend on `react-native-safe-area-context`; use it for `insets` only if your app already has it.

### 0.3.1

- The "Feedback" text pill is now a compact round button, docked at the right edge near 62% of the window height instead of bottom-right, where it covered apps' primary buttons.
- It is draggable and remembers where the tester put it. New props: `buttonPosition`, `insets`.
- `buttonBottom` is deprecated and now only sets the initial position.
- It hides while the keyboard is up.
- The default `strings.button` is "Send feedback" (it is the accessibility label; there is no visible text).

## What is sent

`POST {endpoint}/api/submit` as `multipart/form-data`, with file URIs (no base64 in JS memory):
- `meta`: JSON with `kind`, `text`, `screen`, `app_version`, `build`, `platform`, `device` (model), `os`, `locale`, `device_id`.
- `screenshot`: the screen as JPEG, taken before the sheet opens (so the sheet is not in it); dropped if the user turns the switch off.
- `photo`: each attached photo, in order.
- `thumb`: a 320 px JPEG of the first image.

Every image is resized to at most 1600 px on the long edge (never upscaled) and re-encoded as JPEG quality 0.7, which also removes EXIF such as GPS and bakes the orientation.
An image still over the server limit is refused with a short message.
`device_id` is a random id created once per install; it is not a hardware id.
Limits (image count, bytes, text length) come from `GET {endpoint}/api/limits`, fetched once per app session and kept in memory, with these defaults if it cannot be reached: 4 images, 5 MB each, 15 MB total, 4000 characters.
The send timeout is 20 s plus 10 s per MB, at most 90 s.
Temp files the kit created are deleted after a successful send and when the sheet closes.

## Privacy

The first open per install shows: "Your note, a screenshot of this screen and any photos you attach go to the team. Images are deleted after 90 days." and stores the answer.
Mention attached photos (library and camera) in your own privacy policy.
Nothing is sent until the user taps Send.
There is no offline queue: a failed send shows "Could not send. Try again." and keeps the text and photos.

## Get a project key

```sh
postbox project add my-app "My App"   # prints the public key
```

## Develop

```sh
pnpm --filter @dalathappyfarm/postbox-react-native test
pnpm --filter @dalathappyfarm/postbox-react-native typecheck
pnpm --filter @dalathappyfarm/postbox-react-native build
```
