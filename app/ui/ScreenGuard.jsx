// glibren.28: o error boundary das telas. Uma excecao ao desenhar uma tela (na glibren.27, o botao da pagina do jogo sem
// texto para "converting": "Cannot convert undefined or null to object") desmontava a arvore inteira do React e o app
// ficava congelado, so o botao PS respondia. Agora a tela que falhou vira um aviso (Voltar sai dela) e o resto do app
// (cabecalho, downloads, conversoes) segue. Cada tela tem o seu (index.jsx ScreenFrame, com a chave da tela): abrir
// outra tela, ou a mesma de novo, comeca do zero.

import '../assets/Exo2.ttf';
import { jsx, jsxs } from 'react/jsx-runtime';
import { Component } from 'react';
import { FocusScope, Text, View } from '@ps5-react/core';
import { useT } from '../i18n/index.js';
import { useNavActions } from '../state/nav.jsx';
import { FocusRing } from './FocusRing.jsx';
import { colors, radius } from './colors.js';

  // glibren.28: o aviso no lugar da tela: o texto (focado; X ou Voltar saem) e a mensagem do erro, pequena, para o diario.
  function ScreenFailed({ message }) {
    const t2 = useT();
    const { pop } = useNavActions();
    const back = () => {
      pop();
      return true;
    };
    return jsx(FocusScope, { autoFocus: true, onBack: back, children: jsxs(View, { style: { flex: 1, gap: 16, paddingHorizontal: 48, paddingTop: 24 }, children: [
      jsxs(View, { focusable: true, autoFocus: true, focusKey: "screen-failed", onPress: back, style: (state) => [{ position: "relative", width: 1500, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 24, paddingVertical: 18 }, state.focused ? { backgroundColor: colors.surface2 } : null], children: [
        jsx(FocusRing, {}),
        jsx(Text, { style: { width: 1450, fontFamily: "Exo2", fontSize: 24, lineHeight: 34, color: colors.fg }, children: t2("app.screenFailed") })
      ] }),
      message ? jsx(Text, { style: { width: 1500, fontFamily: "Exo2", fontSize: 18, lineHeight: 26, color: colors.muted, numberOfLines: 2, ellipsizeMode: "tail" }, children: message }) : null
    ] }) });
  }
  var messageOf = (error) => String(error?.message ?? error ?? "").slice(0, 200);
  class ScreenGuard extends Component {
    constructor(props) {
      super(props);
      this.state = { failed: false, message: "" };
    }
    static getDerivedStateFromError(error) {
      return { failed: true, message: messageOf(error) };
    }
    componentDidCatch(error) {
      console.log(`[app] a screen stopped drawing; a notice took its place: ${messageOf(error)}`);
    }
    render() {
      return this.state?.failed ? jsx(ScreenFailed, { message: this.state.message }) : this.props.children;
    }
  }

export { ScreenFailed, ScreenGuard };
