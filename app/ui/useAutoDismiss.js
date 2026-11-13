// glibren.44: os avisos da abertura que so tem "OK" (termos de uso, Novidades, aviso de queda) passam sozinhos se o
// jogador fica AUTO_SECONDS sem apertar nada: o botao mostra a contagem ("OK (10)") e, ao zerar, faz o mesmo que o OK
// (marca como visto). Qualquer botao do controle cancela a contagem (state/activity.js onPress) e o aviso espera o
// jogador, como antes. Enquanto aberto, o aviso conta como dialogo aberto (o reinicio da atualizacao espera).
// Ficam de fora (pedem uma decisao de verdade): a oferta de atualizacao (ui/UpdateDialog.jsx: baixar/reiniciar), a
// pergunta dos relatorios automaticos (ui/AutoReportAsk.jsx: sim/nao), o aviso do .pkg do PS5 (ui/Ps5PkgWarning.jsx) e
// o PIN (ui/PinDialog.jsx).

import { useEffect, useRef, useState } from 'react';
import { holdDialog, onPress, startActivity } from '../state/activity.js';

  var AUTO_SECONDS = 10;
  /**
   * A contagem, sem React: `onLeft(segundos | null)` a cada segundo (null: cancelada por um botao, ou acabou), e
   * `onDone()` ao zerar. -> quem para. `press`: quem avisa de cada botao (state/activity.js onPress).
   */
  function autoDismiss({ seconds = AUTO_SECONDS, tickMs = 1e3, onLeft = () => {}, onDone = () => {}, press = onPress, every = setInterval, stopEvery = clearInterval }) {
    let remaining = seconds;
    let timer = null;
    let stopPress = () => {};
    const stop = () => {
      if (timer !== null) stopEvery(timer);
      timer = null;
      stopPress();
    };
    stopPress = press(() => {
      if (timer === null) return;
      stop();
      onLeft(null);
    });
    onLeft(remaining);
    timer = every(() => {
      remaining -= 1;
      if (remaining > 0) {
        onLeft(remaining);
        return;
      }
      stop();
      onLeft(null);
      onDone();
    }, tickMs);
    return stop;
  }
  /**
   * `active`: o aviso esta na tela; `onDone()`: o que o OK faz. -> os segundos que faltam, ou null (cancelada, ou
   * fora da tela).
   */
  function useAutoDismiss(active, onDone, { seconds = AUTO_SECONDS, tickMs = 1e3 } = {}) {
    const [left, setLeft] = useState(active ? seconds : null);
    const done = useRef(onDone);
    done.current = onDone;
    useEffect(() => {
      if (!active) {
        setLeft(null);
        return void 0;
      }
      startActivity();
      const release = holdDialog();
      const stop = autoDismiss({ seconds, tickMs, onLeft: setLeft, onDone: () => done.current?.() });
      return () => {
        stop();
        release();
      };
    }, [active]);
    return left;
  }
  /** "OK (10)" durante a contagem; so o texto sem ela. */
  var withCountdown = (label, left) => left === null || left === void 0 ? label : `${label} (${left})`;

export { AUTO_SECONDS, autoDismiss, useAutoDismiss, withCountdown };
