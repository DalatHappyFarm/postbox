# @dalathappyfarm/postbox-react-native

In-app feedback with an automatic screenshot and attached photos (library or camera) for React Native and Expo apps.
It sends to a Postbox server (`POST {endpoint}/api/submit`).

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
| `showButton` | boolean | Small floating button, bottom-right; long press hides it for the session |
| `shake` | boolean | Opens the sheet on shake (accelerometer above 2.2 g, 2 s cooldown) |
| `strings` | `Partial<Strings>` | Override any UI text (English defaults) |
| `onError` | `(error: string) => void` | Capture or send failures, for logging |

`useFeedback().open(kind?)` opens the sheet with `bug`, `idea` or `other` preselected.
Keep `showButton` and `shake` off in store builds if you do not want testers' tools there.

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
