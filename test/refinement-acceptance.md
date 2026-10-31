# Refinement acceptance scaffolding

Electron **não executado** nesta entrega. Não iniciar enquanto runtime usa sessão física. Produção, vault e download não editados. Logo rodada 1 rejeitada; rodada 2 pendente, sem teste/golden de marca imposto.

## Entradas

Reusa `ux-acceptance-electron.cjs` somente no ramo `CQ_REFINEMENT_OUTPUT`; suite antiga permanece no ramo padrão. Entrada nova guardada: `refinement-acceptance-electron.cjs`. Sem `--allow-electron` e `--freeze=<manifesto final>` não inicia filho nem importa Electron.

Após freeze aprovado pelo coordenador, gerar manifesto pelo export `snapshot()` e salvar em arquivo novo (não sobrescrever baseline). Formato é mapa exato `caminho relativo a app -> SHA-256`; não é o envelope do baseline histórico. Inclui src/test, package/lock, ícones e addon. Regerar após alteração de testes invalida freeze anterior; nunca regenerar para ocultar mudança de produção durante execução. Snapshot novamente imediatamente antes de spawn e após close.

Comando futuro a partir de `app/`, **não autorizado nesta entrega**:

```powershell
node test/refinement-acceptance-electron.cjs --allow-electron --freeze=<manifesto-final.json> --contract=<contrato-aprovado.json>
```

Sem contrato, somente isolamento, responsive e zero tentativas de login executáveis; demais casos `NOT_EXECUTED`. Não há aprovação global de QA40. `verdict=PASS` do pai significa que casos executados passaram e infraestrutura ficou íntegra; `coverageComplete=false` explicita pendências. `NOT_EXECUTED` não se converte em PASS.

Contrato declarativo opcional, definido pelos donos antes do freeze:

```json
{
  "aim": { "selector": "<seletor aprovado>", "statePath": "<campo canônico off>", "off": false },
  "controls": [{ "action": "<ID de keybind>", "selector": "<controle operacional>" }],
  "process": { "selectionPath": "<campo de seleção>", "expectedSelection": null, "statusSelector": "<status live>", "expectedStatus": "<texto exato no cenário inicial>", "nativeMethod": "<método window.cq de leitura>" },
  "clamp": { "key": "<chave canônica>" },
  "lifecycle": { "key": "<preferência iniciar minimizado>", "initial": true, "visible": false, "minimized": false },
  "motion": { "triggerSelector": "<gatilho>", "targetSelector": "<alvo>", "durationMs": 160, "startOpacity": 0, "midOpacity": 0.5, "endOpacity": 1 }
}
```

Placeholders são documentação, não fixture utilizável. Omitir contrato ainda desconhecido. `controls` deve enumerar todos objetos de ação em keybinds, não apenas um subconjunto conveniente. O seletor de aim exige valores off/hold/toggle; `statePath/off` depende do schema do dono. IPC de processo testa somente leitura/estado inicial, não picker ou foco físico. Seleção live/transições e efeitos de executores continuam `NOT_EXECUTED`, pertencem aos donos runtime/backend.

Lifecycle escreve uma preferência booleana no settings.json **temporário** antes de boot; repetir com contrato normal/minimizado em execuções separadas. Esperados de visibilidade/minimização precisam decisão backend, não copiar observado para aprovar bug. Recuperação chama API da própria janela, não clica tray Windows; não testa startup real.

Motion suporta um único efeito de opacidade enumerável por `getAnimations()` no alvo, 120–200 ms. Frames determinísticos pausados em 0/D/2/D; PNGs e opacidade medida, erro máximo .02. Interpolação esperada (incluindo easing) fornecida por design, nunca derivada do mesmo efeito. CSS sem transição ou duração errada falha. Reduced-motion emula mídia via debugger da janela própria, recarrega e exige estado final sem animação running após um frame. Sem CDP TCP/porta, sem ocupar debugger externo. Transform-only, interrupção, inspeção estética, áudio/SFX e sharpness física não certificados por este scaffold. Runtime terá seu `render-sharpness*`; oráculo independente será revisado depois, sem duplicação.

## Isolamento e evidência

Pai aloca userData/sessionData distintos em `%LOCALAPPDATA%\Temp\opencode\cq-refinement-*`; rejeita caminhos fora da raiz/junctions. Filho bloqueia `app.setLoginItemSettings` antes de main e qualquer tentativa invalida saída. Não há escrita alternativa ou bypass de packaged flag. Startup Windows real exige consentimento específico e outro gate, não fornecido aqui.

Cada execução cria diretório exclusivo `analysis/refinement-20261027/qa-evidence/<run-id>/`: contrato/freeze, logs, parent/summary/cases JSON e PNGs. Sem destino antigo sobrescrito. Snapshot instável invalida resultado; aguardar freeze final. Timeout usa somente PID de filho próprio, deadline finito, FAIL/retém perfil; limpeza pelo pai após close confirmado e sucesso. EBUSY contido, perfil retido/reportado. Não conecta nem encerra app do usuário. Sem porta aberta.

## Autoverificação Node

```powershell
node --test test/refinement-acceptance.test.mjs
```

Somente filhos `process.execPath` Node próprios: guardas, contenção, hashes, resumo granular/falsos positivos, erro numérico/contrato, cleanup, timeout e spawn error. Esses PASS não certificam Electron, app ou Windows. Logs dos cenários em `qa-evidence/node-selfcheck-*/`; saída TAP deve ser arquivada pelo executor. Não altera runner/teste compartilhado dos implementadores.
