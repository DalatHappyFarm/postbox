import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, PanResponder, Platform, Pressable, StatusBar, StyleSheet, View, useWindowDimensions } from "react-native";
import {
  FAB_KEY, FAB_TOUCH, FAB_VISIBLE, clampFab, fabX, initialFab, isDrag, parseFab, serializeFab, snapFab, toInsets,
  type FabPos, type Insets, type Store,
} from "./core.js";

export type FloatingButtonProps = {
  /** False while the sheet is open; the component stays mounted so the position survives. */
  visible: boolean;
  label: string;
  colors: { bg: string; fg: string };
  store: Store;
  insets?: Partial<Insets>;
  buttonPosition?: { side: "left" | "right"; y: number };
  buttonBottom?: number;
  onPress: () => void;
  onHide: () => void;
};

// ponytail: guessed system bars when the app passes no insets (notch or island on top, home indicator below); the app passes `insets` for exact values.
const guessInsets = (): Insets =>
  Platform.OS === "ios" ? { top: 54, right: 0, bottom: 34, left: 0 } : { top: StatusBar.currentHeight ?? 24, right: 0, bottom: 0, left: 0 };

/** Round 44 pt button, docked to a side edge, draggable; a tap opens, a drag never does, a long press hides. */
export function FloatingButton(p: FloatingButtonProps) {
  const win = useWindowDimensions();
  const i = p.insets ? toInsets(p.insets) : guessInsets();
  const live = useRef({ win, i, p });
  live.current = { win, i, p };
  const [ready, setReady] = useState(false);
  const [init] = useState(() => {
    const start = initialFab(win, i, p);
    const at = { x: fabX(start.side, win, i), y: start.y };
    return { start, at, xy: new Animated.ValueXY(at) };
  });
  const xy = init.xy;
  const pos = useRef<FabPos>(init.start); // where the button wants to be; rendering clamps it to the current window
  const cur = useRef(init.at); // where it is now, for drag starts
  const moved = useRef(false);

  const place = (q: FabPos, animate: boolean) => {
    const { win: w, i: ins } = live.current;
    const to = { x: fabX(q.side, w, ins), y: clampFab(q, w, ins).y };
    if (animate) Animated.spring(xy, { toValue: to, useNativeDriver: false, bounciness: 6 }).start();
    else xy.setValue(to);
  };

  useEffect(() => {
    const id = xy.addListener((v) => { cur.current = v; });
    return () => xy.removeListener(id);
  }, [xy]);

  // The stored position (a past drag) beats the props; the button shows only after the read so it never jumps.
  useEffect(() => {
    let on = true;
    p.store.get(FAB_KEY).then(parseFab, () => null).then((saved) => {
      if (!on) return;
      if (saved) { pos.current = saved; place(saved, false); }
      setReady(true);
    });
    return () => { on = false; };
  }, []);

  // Rotation, split view or new insets: stay inside the safe area.
  useEffect(() => { place(pos.current, false); }, [win.width, win.height, i.top, i.right, i.bottom, i.left]);

  const pan = useMemo(() => {
    let from = { x: 0, y: 0 };
    const drop = (g: { dx: number; dy: number }) => {
      const { win: w, i: ins, p: props } = live.current;
      const next = snapFab(from.x + g.dx, from.y + g.dy, w, ins);
      pos.current = next;
      place(next, true);
      void props.store.set(FAB_KEY, serializeFab(next)).catch(() => {});
    };
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => isDrag(g.dx, g.dy),
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => { moved.current = true; xy.stopAnimation(); from = { ...cur.current }; },
      onPanResponderMove: (_, g) => xy.setValue({ x: from.x + g.dx, y: from.y + g.dy }),
      onPanResponderRelease: (_, g) => drop(g),
      onPanResponderTerminate: (_, g) => drop(g),
    });
  }, []);

  if (!p.visible || !ready) return null;
  return (
    <Animated.View {...pan.panHandlers} onTouchStart={() => { moved.current = false; }} style={[s.box, { transform: xy.getTranslateTransform() }]}>
      <Pressable
        accessibilityRole="button" accessibilityLabel={p.label} onPress={() => { if (!moved.current) p.onPress(); }} onLongPress={p.onHide}
        style={({ pressed }) => [s.touch, { opacity: pressed ? 1 : 0.8 }]}
      >
        <View style={[s.circle, { backgroundColor: p.colors.bg }]}>
          <View style={s.icon}>
            <View style={[s.bubble, { backgroundColor: p.colors.fg }]}>
              {[0, 1, 2].map((n) => <View key={n} style={[s.dot, { backgroundColor: p.colors.bg }]} />)}
            </View>
            <View style={[s.tail, { borderTopColor: p.colors.fg }]} />
          </View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  box: { position: "absolute", left: 0, top: 0, width: FAB_TOUCH, height: FAB_TOUCH },
  touch: { width: FAB_TOUCH, height: FAB_TOUCH, alignItems: "center", justifyContent: "center" },
  circle: {
    width: FAB_VISIBLE, height: FAB_VISIBLE, borderRadius: FAB_VISIBLE / 2, alignItems: "center", justifyContent: "center",
    shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 4,
  },
  // Chat bubble drawn with Views (18 x 13 plus a 5 pt tail), nudged up so bubble and tail are centred together.
  icon: { width: 18, height: 13, transform: [{ translateY: -2 }] },
  bubble: { width: 18, height: 13, borderRadius: 4, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 2.5 },
  dot: { width: 3, height: 3, borderRadius: 1.5 },
  tail: { position: "absolute", left: 3, top: 12, width: 0, height: 0, borderTopWidth: 5, borderRightWidth: 5, borderRightColor: "transparent" },
});
