import * as Application from "expo-application";
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";
import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { Accelerometer } from "expo-sensors";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator, Image, KeyboardAvoidingView, ScrollView, Modal, Platform, Pressable, StyleSheet, Switch, Text, TextInput, View, useColorScheme,
} from "react-native";
import { captureScreen } from "react-native-view-shot";
import {
  DEFAULT_LIMITS, buildParts, cleanup, getDeviceId, getLimits, giveConsent, hasConsent, isShake, makeThumb, pick, processImage, send,
  sendTimeout, slotsLeft,
  type Context as Ctx, type ImageDeps, type Img, type Kind, type Limits, type PickDeps, type Store,
} from "./core.js";

export type Strings = {
  button: string; title: string; include: string; placeholder: string; send: string; cancel: string;
  bug: string; idea: string; other: string; sent: string; failed: string;
  consent: string; consentOk: string;
  addPhoto: string; library: string; camera: string; removePhoto: string; screenshotPreview: string;
  cameraDenied: string; tooLarge: string; photoFailed: string;
};

const DEFAULTS: Strings = {
  button: "Feedback", title: "Send feedback", include: "Include screenshot", placeholder: "What happened, or what would help?",
  send: "Send", cancel: "Cancel", bug: "Bug", idea: "Idea", other: "Other", sent: "Thanks, sent", failed: "Could not send. Try again.",
  consent: "Your note, a screenshot of this screen and any photos you attach go to the team. Images are deleted after 90 days.", consentOk: "OK, continue",
  addPhoto: "Add photo", library: "Photo library", camera: "Camera", removePhoto: "Remove photo", screenshotPreview: "Screenshot preview",
  cameraDenied: "Camera access is off. Turn it on for this app in Settings to take a photo.",
  tooLarge: "That photo is too large to send.", photoFailed: "Could not add that photo.",
};

// Native glue. The logic lives in core.ts so it is tested without a device.
const imageDeps: ImageDeps = {
  getSize: (uri) => new Promise((ok, fail) => Image.getSize(uri, (width, height) => ok({ width, height }), fail)),
  async manipulate(uri, resize, quality) {
    const ctx = ImageManipulator.manipulate(uri);
    try {
      const ref = await (resize ? ctx.resize(resize) : ctx).renderAsync();
      try {
        const r = await ref.saveAsync({ compress: quality, format: SaveFormat.JPEG });
        return { uri: r.uri, width: r.width, height: r.height };
      } finally { ref.release(); }
    } finally { ctx.release(); }
  },
  bytes: (uri) => new File(uri).size,
  remove: (uri) => { const f = new File(uri); if (f.exists) f.delete(); },
};
const pickOpts = { mediaTypes: ["images"], quality: 1, exif: false, base64: false } satisfies ImagePicker.ImagePickerOptions;
const pickDeps: PickDeps = {
  library: (limit) => ImagePicker.launchImageLibraryAsync({ ...pickOpts, allowsMultipleSelection: true, selectionLimit: limit }),
  camera: () => ImagePicker.launchCameraAsync(pickOpts),
  // Asked only when the user taps Camera.
  cameraPermission: async () => (await ImagePicker.requestCameraPermissionsAsync()).granted,
};

export type FeedbackProviderProps = {
  /** Base URL of your Postbox server, for example https://postbox.example.com */
  endpoint: string;
  projectKey: string;
  /** Name of the current screen, read when the sheet opens. */
  getScreen?: () => string;
  /** Floating button, bottom-right; long press hides it for the session. */
  showButton?: boolean;
  /** Distance of the floating button from the bottom edge, to clear a tab bar (default 96). */
  buttonBottom?: number;
  /** Open the sheet on shake. */
  shake?: boolean;
  strings?: Partial<Strings>;
  onError?: (error: string) => void;
  children: ReactNode;
};

const Ctx_ = createContext<{ open: (kind?: Kind) => void }>({ open: () => {} });
export const useFeedback = () => useContext(Ctx_);

// expo-secure-store: ships with Expo SDK, so no extra native module; consent and id are tiny.
const store: Store = {
  get: (k) => SecureStore.getItemAsync(k),
  set: (k, v) => SecureStore.setItemAsync(k, v),
};

type Step = "closed" | "consent" | "form" | "sent";

export function FeedbackProvider(p: FeedbackProviderProps) {
  const t = { ...DEFAULTS, ...p.strings };
  const dark = useColorScheme() === "dark";
  const c = dark ? DARK : LIGHT;
  const [step, setStep] = useState<Step>("closed");
  const [hidden, setHidden] = useState(false);
  const [kind, setKind] = useState<Kind>("bug");
  const [text, setText] = useState("");
  const [shot, setShot] = useState<Img | null>(null);
  const [photos, setPhotos] = useState<Img[]>([]);
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS);
  const [choosing, setChoosing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [include, setInclude] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const busyOpen = useRef(false);
  const stepRef = useRef<Step>("closed");
  stepRef.current = step;
  const ref = useRef(p);
  ref.current = p;
  // Every temp file the kit made; deleted when the sheet closes or after a successful send.
  const files = useRef(new Set<string>());
  const dropFiles = (uris: string[]) => { cleanup(uris, imageDeps.remove); uris.forEach((u) => files.current.delete(u)); };
  const track = (i: Img) => { files.current.add(i.uri); return i; };
  const clearAll = () => { dropFiles([...files.current]); setShot(null); setPhotos([]); setNote(null); setChoosing(false); };

  const open = useCallback(async (k?: Kind) => {
    if (busyOpen.current || stepRef.current !== "closed") return; // a shake while the sheet is open must not recapture
    busyOpen.current = true;
    try {
      clearAll();
      let img: Img | null = null;
      const lim = await getLimits(ref.current.endpoint);
      setLimits(lim);
      try {
        // Capture before the sheet shows so the sheet is not in the picture. Temp file, never base64 in JS memory.
        // Encoded once at the final size and quality: a screenshot has no EXIF and no rotation, so it skips the photo pass.
        const uri = await captureScreen({ format: "jpg", quality: 0.7, result: "tmpfile", width: 1080 });
        files.current.add(uri);
        const bytes = imageDeps.bytes(uri);
        if (bytes > lim.max_image_bytes) { imageDeps.remove(uri); files.current.delete(uri); }
        else img = { uri, bytes, ...(await imageDeps.getSize(uri)) };
      } catch (e) {
        ref.current.onError?.(`capture: ${String((e as Error)?.message ?? e)}`);
      }
      setShot(img); setInclude(img !== null); setError(false);
      if (k) setKind(k);
      setStep((await hasConsent(store).catch(() => false)) ? "form" : "consent");
    } finally {
      busyOpen.current = false;
    }
  }, []);

  useEffect(() => {
    if (!p.shake) return;
    let last = 0;
    Accelerometer.setUpdateInterval(100);
    const sub = Accelerometer.addListener((a) => {
      const now = Date.now();
      if (isShake(a, now, last)) { last = now; void open(); }
    });
    return () => sub.remove();
  }, [p.shake, open]);

  const close = () => { setStep("closed"); setText(""); clearAll(); };

  const slots = slotsLeft(limits.max_attachments, shot !== null && include, photos.length);

  const add = async (source: "library" | "camera") => {
    setChoosing(false); setNote(null);
    try {
      const r = await pick(pickDeps, source, slots);
      if (r.kind === "denied") return setNote(t.cameraDenied);
      if (r.kind !== "ok") return;
      const added: Img[] = [];
      let failed: string | null = null;
      for (const a of r.assets) {
        files.current.add(a.uri);
        try {
          added.push(track(await processImage(imageDeps, a.uri, limits.max_image_bytes, a)));
        } catch (e) {
          failed = (e as Error).message === "too_large" ? t.tooLarge : t.photoFailed;
        }
        files.current.delete(a.uri);
      }
      setPhotos((cur) => [...cur, ...added]);
      setNote(failed);
    } catch (e) {
      setNote(t.photoFailed); p.onError?.(`pick: ${String((e as Error)?.message ?? e)}`);
    }
  };

  const removePhoto = (i: Img) => { dropFiles([i.uri]); setPhotos((cur) => cur.filter((x) => x !== i)); setNote(null); };

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setError(false);
    const context: Ctx = {
      screen: ref.current.getScreen?.(),
      app_version: Application.nativeApplicationVersion,
      build: Application.nativeBuildVersion,
      platform: Platform.OS,
      device: Device.modelName,
      os: Device.osVersion,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      device_id: await getDeviceId(store).catch(() => "unknown"),
    };
    const deviceId = context.device_id ?? "";
    // ponytail: no offline queue; a failed send keeps the text and asks to retry. Add a persisted queue if testers often send offline.
    const sendShot = shot && include ? shot : null;
    const ordered = [...(sendShot ? [sendShot] : []), ...photos];
    // Thumbnail of the first image in send order, built per send so it never goes stale.
    const thumb = ordered.length ? await makeThumb(imageDeps, ordered[0]).then(track, () => null) : null;
    const parts = buildParts({ meta: { ...context, kind, text }, maxText: limits.max_text, screenshot: sendShot, photos, thumb });
    const bytes = [...ordered, ...(thumb ? [thumb] : [])].reduce((n, i) => n + i.bytes, 0);
    if (bytes > limits.max_total_bytes) { // do not upload what the server will refuse
      setBusy(false); setNote(t.tooLarge); if (thumb) dropFiles([thumb.uri]); return;
    }
    const r = await send(p.endpoint, p.projectKey, parts, sendTimeout(bytes), fetch, deviceId);
    setBusy(false);
    if (r.ok) { clearAll(); setStep("sent"); setText(""); setTimeout(close, 1500); return; }
    if (thumb) dropFiles([thumb.uri]);
    setError(true); p.onError?.(r.error);
  };

  const value = useMemo(() => ({ open: (k?: Kind) => void open(k) }), [open]);
  const kinds: [Kind, string][] = [["bug", t.bug], ["idea", t.idea], ["other", t.other]];

  return (
    <Ctx_.Provider value={value}>
      {p.children}
      {p.showButton && !hidden && step === "closed" && (
        <Pressable
          accessibilityRole="button" accessibilityLabel={t.button} onPress={() => void open()} onLongPress={() => setHidden(true)}
          style={[s.fab, { backgroundColor: c.fab, bottom: p.buttonBottom ?? 96 }]}
        >
          <Text style={[s.fabText, { color: c.fabText }]}>{t.button}</Text>
        </Pressable>
      )}
      <Modal visible={step !== "closed"} transparent animationType="slide" onRequestClose={close}>
        <KeyboardAvoidingView style={s.scrim} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={[s.sheet, { backgroundColor: c.bg }]}>
            {step === "consent" && (
              <>
                <Text style={[s.title, { color: c.text }]}>{t.title}</Text>
                <Text style={[s.body, { color: c.text }]}>{t.consent}</Text>
                <Btn c={c} primary label={t.consentOk} onPress={() => { void giveConsent(store).catch(() => {}); setStep("form"); }} />
                <Btn c={c} label={t.cancel} onPress={close} />
              </>
            )}
            {step === "sent" && <Text style={[s.title, { color: c.text }]} accessibilityLiveRegion="polite">{t.sent}</Text>}
            {step === "form" && (
              <>
                <Text style={[s.title, { color: c.text }]}>{t.title}</Text>
                <View style={s.row}>
                  {kinds.map(([k, label]) => (
                    <Pressable key={k} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: kind === k }}
                      onPress={() => setKind(k)} style={[s.chip, { borderColor: c.border, backgroundColor: kind === k ? c.fab : "transparent" }]}>
                      <Text style={{ color: kind === k ? c.fabText : c.text }}>{label}</Text>
                    </Pressable>
                  ))}
                </View>
                <TextInput
                  accessibilityLabel={t.placeholder} placeholder={t.placeholder} placeholderTextColor={c.muted} multiline
                  value={text} onChangeText={setText} maxLength={limits.max_text} style={[s.input, { color: c.text, borderColor: c.border }]}
                />
                {shot && (
                  <View style={s.row}>
                    <Image accessibilityLabel={t.screenshotPreview} source={{ uri: shot.uri }} style={[s.thumb, { opacity: include ? 1 : 0.3 }]} />
                    <Text style={[s.grow, { color: c.text }]}>{t.include}</Text>
                    <Switch accessibilityLabel={t.include} value={include} onValueChange={setInclude} />
                  </View>
                )}
                {photos.length > 0 && (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row}>
                    {photos.map((ph, n) => (
                      <View key={ph.uri}>
                        <Image accessibilityIgnoresInvertColors source={{ uri: ph.uri }} style={s.thumb} />
                        <Pressable accessibilityRole="button" accessibilityLabel={`${t.removePhoto} ${n + 1}`} onPress={() => removePhoto(ph)} hitSlop={0}
                          style={[s.remove, { backgroundColor: c.fab }]}>
                          <Text style={{ color: c.fabText, fontWeight: "700" }}>x</Text>
                        </Pressable>
                      </View>
                    ))}
                  </ScrollView>
                )}
                {slots > 0 && !choosing && <Btn c={c} label={t.addPhoto} onPress={() => setChoosing(true)} />}
                {slots > 0 && choosing && (
                  <View style={s.row}>
                    <View style={s.grow}><Btn c={c} label={t.library} onPress={() => void add("library")} /></View>
                    <View style={s.grow}><Btn c={c} label={t.camera} onPress={() => void add("camera")} /></View>
                  </View>
                )}
                {note && <Text accessibilityLiveRegion="polite" style={s.err}>{note}</Text>}
                {error && <Text accessibilityLiveRegion="polite" style={s.err}>{t.failed}</Text>}
                <View style={s.row}>
                  <View style={s.grow}><Btn c={c} label={t.cancel} onPress={close} /></View>
                  <View style={s.grow}>
                    {busy ? <ActivityIndicator style={s.btn} /> : <Btn c={c} primary label={t.send} onPress={() => void submit()} disabled={!text.trim()} />}
                  </View>
                </View>
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </Ctx_.Provider>
  );
}

function Btn(p: { c: typeof LIGHT; label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={p.label} accessibilityState={{ disabled: !!p.disabled }}
      disabled={p.disabled} onPress={p.onPress}
      style={[s.btn, { backgroundColor: p.primary ? p.c.fab : "transparent", opacity: p.disabled ? 0.4 : 1, borderColor: p.c.border, borderWidth: p.primary ? 0 : 1 }]}>
      <Text style={{ color: p.primary ? p.c.fabText : p.c.text, fontWeight: "600" }}>{p.label}</Text>
    </Pressable>
  );
}

const LIGHT = { bg: "#FFFFFF", text: "#111111", muted: "#777777", border: "#CCCCCC", fab: "#111111", fabText: "#FFFFFF" };
const DARK = { bg: "#1C1C1E", text: "#F2F2F7", muted: "#8E8E93", border: "#444448", fab: "#F2F2F7", fabText: "#111111" };

const s = StyleSheet.create({
  fab: { position: "absolute", right: 16, minHeight: 44, minWidth: 44, paddingHorizontal: 14, borderRadius: 22, alignItems: "center", justifyContent: "center", opacity: 0.85 },
  fabText: { fontSize: 13, fontWeight: "600" },
  scrim: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: { padding: 16, paddingBottom: 32, borderTopLeftRadius: 16, borderTopRightRadius: 16, gap: 12 },
  title: { fontSize: 18, fontWeight: "700" },
  body: { fontSize: 15, lineHeight: 21 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  grow: { flex: 1 },
  chip: { minHeight: 44, paddingHorizontal: 16, borderRadius: 22, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  input: { minHeight: 96, maxHeight: 180, borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 16, textAlignVertical: "top" },
  thumb: { width: 44, height: 78, borderRadius: 6 },
  remove: { position: "absolute", top: -8, right: -8, width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  btn: { minHeight: 44, borderRadius: 10, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  err: { color: "#D92D20", fontSize: 14 },
});
