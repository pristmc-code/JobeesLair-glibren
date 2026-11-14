// glibren.56 (abertura minima, state/opening.js): o que a Jobe mostra entre abrir e a loja estar pronta. So o logo (a marca
// JL, parada no meio da tela) e, em volta dele, um anel de pontos girando (a cabeca vermelha, a cauda no tom do tema,
// sumindo). Nenhum texto, nenhum botao, nada para apertar: fica ate a loja estar pronta (index.jsx: o catalogo montado, do
// payload ou do app) e entao sai depressa, com a loja ja desenhada embaixo.
// Dentro dos limites do motor (ps5-react docs/ANIMATION.md): o que gira e pequeno (420 px, abaixo de 512) e os pontos
// dentro dele nao se mexem sozinhos (nenhum loop dentro de um no girando); a unica mudanca de tela cheia e o fundo sumindo
// uma vez no fim.

import { jsx, jsxs } from 'react/jsx-runtime';
import { useEffect, useRef } from 'react';
import { View, motion } from '@ps5-react/core';
import { JLMark, J_RED } from './JLMark.jsx';
import { colors } from './colors.js';
import { EASE_OUT } from './ease.js';

  // A tela em pixels de saida e o meio dela.
  var W = 1920, H = 1080, CX = W / 2, CY = H / 2;
  // A marca: 150 de altura (225 de largura); o anel, 420 de lado, com os pontos num raio de 186.
  var MARK_H = 150;
  var MARK_W = MARK_H * 1.5;
  var RING = 420;
  var RADIUS = 186;
  var DOTS = 12;
  // Uma volta a cada 1,6 s, sem fim.
  var SPIN = { type: "tween", duration: 1.6, ease: "linear", repeat: Infinity };
  var ARRIVE = { type: "tween", duration: 0.45, ease: EASE_OUT };
  var LEAVE = { type: "tween", duration: 0.35, ease: [0.4, 0, 0.2, 1] };
  // Quanto a saida leva (o fundo sumindo) antes de avisar onDone.
  var LEAVE_MS = 380;
  // O ponto `index` (0 = a cabeca): onde fica no anel, o tamanho e o quanto aparece (a cauda vai sumindo).
  function dot(index) {
    const angle = -90 - index * (300 / DOTS);
    const rad = angle * Math.PI / 180;
    const size = Math.max(6, 20 - index * 1.2);
    return {
      left: RING / 2 + RADIUS * Math.cos(rad) - size / 2,
      top: RING / 2 + RADIUS * Math.sin(rad) - size / 2,
      size,
      opacity: Math.max(0.12, 1 - index * 0.08),
      color: index === 0 ? J_RED : index < 4 ? colors.accentHi : colors.accent
    };
  }
  var DOT_LIST = Array.from({ length: DOTS }, (_, index) => dot(index));
  /** O anel girando: a unica coisa que se mexe enquanto a loja fica pronta. */
  function Spinner() {
    return jsx(motion.View, {
      initial: { rotate: 0 },
      animate: { rotate: 360 },
      transition: SPIN,
      style: { position: "absolute", left: CX - RING / 2, top: CY - RING / 2, width: RING, height: RING },
      children: DOT_LIST.map((spot, index) => jsx(View, { style: { position: "absolute", left: spot.left, top: spot.top, width: spot.size, height: spot.size, borderRadius: spot.size / 2, opacity: spot.opacity, backgroundColor: spot.color } }, index))
    }, "spinner");
  }
  /**
   * `leaving`: a loja esta pronta (montada embaixo): o fundo some e, no fim, `onDone()` (quem chamou desmonta isto).
   */
  function Opening({ leaving = false, onDone }) {
    const finished = useRef(false);
    useEffect(() => {
      if (!leaving) return void 0;
      const id = setTimeout(() => {
        if (finished.current) return;
        finished.current = true;
        onDone?.();
      }, LEAVE_MS);
      return () => clearTimeout(id);
    }, [leaving]);
    return jsxs(View, { style: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 100 }, children: [
      // O fundo: a unica camada de tela cheia, que some uma vez, no fim.
      jsx(motion.View, { initial: false, animate: { opacity: leaving ? 0 : 1 }, transition: LEAVE, style: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.canvas } }, "backdrop"),
      leaving ? null : jsx(Spinner, {}, "spinner"),
      // O logo: entra crescendo um pouco e sai junto com o fundo.
      jsx(motion.View, {
        initial: { scale: 0.7, opacity: 0 },
        animate: leaving ? { scale: 0.9, opacity: 0 } : { scale: 1, opacity: 1 },
        transition: leaving ? LEAVE : ARRIVE,
        style: { position: "absolute", left: CX - MARK_W / 2, top: CY - MARK_H / 2, width: MARK_W, height: MARK_H },
        children: jsx(JLMark, { height: MARK_H })
      }, "mark")
    ] });
  }

export { DOTS, LEAVE_MS, Opening };
