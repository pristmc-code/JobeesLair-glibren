// Pareamento por aparelho: "Aparelhos pareados" e "Aceitar o PIN antigo" em Configuracoes > Downloads (logo abaixo do
// PIN da pagina do celular). Quem guarda os aparelhos e o payload (app/native/bg_pair.c; state/device-pairing.js); aqui
// so a lista (o mais novo primeiro), "Remover" com confirmacao (apertar de novo; o token do aparelho deixa de valer na
// hora) e o PIN antigo ligado/desligado na transicao. Linhas proprias: nome e data quebram linha (sem reticencias).
// Switch vem do Settings.jsx (o mesmo das outras linhas).
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { useEffect, useState } from 'react';
import { useT } from '../i18n/index.js';
import { formatDate2 } from '../i18n/core.js';
import { isoDate } from '../state/clock.js';
import { pairingStatus, removePairedDevice, setLegacyPin } from '../state/device-pairing.js';
import { colors, radius } from './colors.js';
import { FocusRing } from './FocusRing.jsx';
import { Icon } from './Icon.jsx';
import { LongText } from './LongText.jsx';
import { Text, View, useIsFocused } from '@ps5-react/core';

var text = (size, color, extra) => ({ fontFamily: "Exo2", fontSize: size, lineHeight: Math.round(size * 1.4), color, ...extra });
var ROW = (state) => [{ position: "relative", flexDirection: "row", alignItems: "center", gap: 24, borderRadius: radius.md, paddingHorizontal: 20, paddingVertical: 16, marginHorizontal: -20 }, state.focused ? { backgroundColor: colors.surface3 } : null];
// A data do pareamento (segundos) no formato do idioma, sem objeto Date (o motor do PS5 so tem Date.now(); state/clock.js).
var day = (at) => at ? formatDate2(isoDate(at * 1e3)) : "";

function Face({ name, detail, hint, end, tone }) {
  const focused = useIsFocused();
  return jsxs(Fragment, { children: [
    jsx(FocusRing, { round: "md" }),
    jsxs(View, { style: { flex: 1, gap: 3 }, children: [
      jsx(Text, { style: text(23, colors.fg, { fontWeight: 600 }), children: name }),
      // LongText: um Text guarda ate 255 bytes (a lista de nomes pode passar disso).
      detail ? jsx(LongText, { style: text(20, tone || (focused ? colors.fg : colors.muted)), children: detail }) : null,
      hint && focused ? jsx(LongText, { style: text(20, colors.muted), children: hint }) : null
    ] }),
    end
  ] });
}
function Line({ focusKey, onPress, ...face }) {
  return jsx(View, { focusKey, onPress, style: ROW, children: jsx(Face, face) });
}

function PairedDevicesRows({ Switch }) {
  const t2 = useT();
  const [state, setState] = useState(void 0); // undefined: lendo; null: payload fora do ar (ou antigo)
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    pairingStatus().then((next) => {
      if (alive) setState(next);
    }, () => {});
    return () => {
      alive = false;
    };
  }, [tick]);
  const refresh = () => setTick((n) => n + 1);
  const devices = state?.devices ?? [];
  const remove = (device) => {
    setArmed(null);
    removePairedDevice(device.id).then(refresh, refresh);
  };
  const summary = state === void 0 ? "" : state === null ? t2("settings.devicesOff") : devices.length ? devices.map((device) => device.name).join(", ") : t2("settings.devicesNone");
  return jsxs(Fragment, { children: [
    jsx(Line, { focusKey: "settings:devices", name: t2("settings.devices"), detail: summary, hint: t2("settings.devicesHint"),
      end: state ? jsx(Icon, { name: open ? "chevronUp" : "chevronDown", color: colors.muted }) : null, onPress: () => {
        setOpen(!open);
        setArmed(null);
        refresh();
      } }),
    ...open && state ? devices.map((device) => jsx(Line, {
      focusKey: `settings:device:${device.id}`,
      name: device.name,
      detail: armed === device.id ? t2("settings.deviceRemove") : t2("settings.deviceAt", { date: day(device.at) }),
      tone: armed === device.id ? "#f87171" : null,
      end: jsx(Icon, { name: armed === device.id ? "delete" : "x", color: armed === device.id ? "#f87171" : colors.muted }),
      onPress: () => armed === device.id ? remove(device) : setArmed(device.id)
    }, device.id)) : [],
    // O PIN antigo: so quando ha um definido ou ele ja foi desligado (sem PIN nao ha o que aceitar).
    state && (state.pinSet || !state.pinOn) ? jsx(Line, { focusKey: "settings:legacyPin", name: t2("settings.legacyPin"), hint: t2("settings.legacyPinHint"),
      end: jsx(Switch, { on: state.pinOn }), onPress: () => setLegacyPin(!state.pinOn).then(refresh, refresh) }) : null
  ] });
}

export { PairedDevicesRows };
