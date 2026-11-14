# OpenCrosshairQ

<p align="center">
  <img src="assets/brand/wordmark-full-horizontal-blue.svg" alt="OpenCrosshairQ Logo" width="480">
</p>

<p align="center">
  <strong>Mira externa de alta precisão, gratuita, open-source e 100% offline-first para Windows.</strong><br>
  Alternativa livre ao CrosshairX, sem injeção no jogo e sem telemetria. Uso sujeito às regras de cada jogo.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License MIT">
  <img src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D6.svg" alt="Windows Platform">
  <a href="https://github.com/quedinhadev/OpenCrosshairQ/actions/workflows/ci.yml"><img src="https://github.com/quedinhadev/OpenCrosshairQ/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/electron-45.0.0-47848F.svg" alt="Electron">
  <img src="https://img.shields.io/badge/offline--first-100%25-success.svg" alt="Offline-First">
</p>

---

## Sumário

- [Por que OpenCrosshairQ?](#por-que-opencrosshairq)
- [Segurança e Anti-Cheat](#segurança-e-anti-cheat)
- [Principais Funcionalidades](#principais-funcionalidades)
- [Download e Instalação](#download-e-instalação)
- [Como Usar](#como-usar)
- [Compilação a partir do Código-Fonte](#compilação-a-partir-do-código-fonte)
- [Como Contribuir](#como-contribuir)
- [Licença](#licença)

---

## Por que OpenCrosshairQ?

Muitos softwares comerciais de miras cobram assinaturas ou valores altos, exigem conexão contínua com a internet, exibem anúncios ou utilizam métodos invasivos de injeção que podem disparar alertas falsos em sistemas anti-cheat.

O **OpenCrosshairQ** foi criado pela comunidade para ser:
1. **100% Gratuito e Código Aberto:** Todo o código é aberto sob licença MIT. Sem paywalls, sem assinaturas.
2. **Offline-First e Privativo:** Miras e perfis ficam locais, sem login, rastreadores ou telemetria. Atualizador consulta GitHub via HTTPS; funcionamento da mira não exige conexão.
3. **Leve e Otimizado:** Desenvolvido em Electron com aceleração gráfica acelerada e módulo nativo C Win32 para consumo mínimo de CPU/GPU.
4. **Precisão de Pixel:** Renderização matemática de subpixel com compensação para monitores de alto DPI e taxas de atualização elevadas.

---

## Segurança e Anti-Cheat

### O OpenCrosshairQ pode causar banimento?
Não existe garantia de ausência de punição. Consulte as regras do jogo e torneio antes de usar uma mira externa. O OpenCrosshairQ opera como sobreposição externa:
- **Zero injeção de DLLs ou threads** em jogos.
- **Zero leitura ou gravação de memória** de processos externos (`PROCESS_VM_READ` ou `PROCESS_VM_WRITE`).
- **Zero hooking de gráficos** (não intercepta chamadas de DirectX, Vulkan ou OpenGL).
- O overlay é uma janela padrão do Windows com propriedades nativas transparentes (`WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_TOOLWINDOW`). Todos os cliques passam diretamente para o jogo abaixo (click-through nativo).

Essa arquitetura não equivale a uma mira física de monitor e não comprova aprovação por Vanguard, EAC, BattlEye ou outros anti-cheats. Compatibilidade depende das políticas de cada fornecedor.

> *Consulte [SECURITY.md](SECURITY.md) para detalhes da arquitetura técnica de segurança.*

---

## Principais Funcionalidades

- **Criador Visual Completo (Designer):**
  - Camadas vetoriais personalizáveis: linhas, círculos, chevrons, cruzes e polígonos.
  - Editor de desenho livre (raster pixelado) e camada de texto.
  - **Shape Cut:** Recorte dinâmico de formas em canvas 700x700.
  - **Animações de Disparo:** Comportamentos automáticos de recuo e disparo sincronizados com cliques e botões do mouse ou controle.
  - Histórico de 100 níveis de desfazer/refazer (`Ctrl+Z` / `Ctrl+Y`) com coalescência de 300 ms.
- **Biblioteca de Miras e Perfis por Jogo:**
  - Salve quantas miras desejar em formato JSON local.
  - Troca automática de mira com base no executável em primeiro plano (detecção opcional via addon nativo C Win32).
- **Atalhos Globais e de Ação:**
  - Oculte ou exiba a mira a qualquer momento via tecla de atalho (`Alt+Shift+Z` padrão, configurável).
  - Mirar, Atirar e Recarregar são remapeáveis na página **Atalhos** e usam um hook de teclado passivo (`WH_KEYBOARD_LL`) que apenas observa as teclas: todo evento é repassado ao sistema (`CallNextHookEx`), sem sintetizar ou bloquear entrada.
- **Compartilhamento por código (código-fonte v0.2.0):**
  - Códigos compactos `CQ2:` funcionam offline, sem conta. Copie em **Compartilhar** no Criador ou na biblioteca; cole em **Importar** para salvar nos favoritos e aplicar.
  - Importação mantém suporte a `CQ1:` e arquivos JSON antigos. Limites: código até 2 MiB e documento descomprimido até 20 MiB, além dos limites de camadas e imagens. Retículas com imagens podem gerar códigos grandes.
- **Atualizações (código-fonte v0.2.0):**
  - Instalador NSIS e Portable verificam releases estáveis no GitHub após iniciar e a cada 6 horas, baixando em segundo plano. Aplicar atualização e reiniciar exigem confirmação do usuário.
  - Portable verifica SHA-256, substitui seu próprio executável mantendo backup e não instala o aplicativo no Windows. Pasta precisa permitir escrita; erros preservam versão anterior e dados locais.
  - Modo de desenvolvimento não faz atualização automática. Versão v0.1.0 precisa de atualização manual para receber o atualizador.
- **Servidor HTTP local:**
  - Expõe status em `127.0.0.1`. Ainda não fornece página de mira para Browser Source nem configura OBS automaticamente.
- **Visibilidade em Capturas (configurável):**
  - Por padrão a mira **aparece em gravações e capturas de tela** (`captureVisible:true`): a janela do overlay não usa proteção de conteúdo, então **OBS Display Capture** e gravadores de tela desktop a incluem, mantendo transparência, click-through e topo.
  - Para ocultar a mira em capturas, defina `captureVisible:false` (via IPC `cq:set`; sem controle na interface nesta versão). A janela passa a usar `setContentProtection` do Electron (`WDA_EXCLUDEFROMCAPTURE`).
  - **OBS Game Capture** captura apenas o framebuffer do jogo: janelas externas do overlay **não** aparecem, com ou sem a opção. Use OBS Display Capture.
  - A mudança de configuração só surte efeito na próxima composição do desktop; capturas iniciadas no mesmo instante podem ainda incluir a janela.
- **Suporte Multimonitor e DPI Dinâmico:**
  - Alinhamento automático ao centro geométrico físico com suporte a escalas de 100%, 125%, 150%, 200% e multitelas.

---

## Download e Instalação

Acesse a página de [Releases](https://github.com/quedinhadev/OpenCrosshairQ/releases) para baixar a versão mais recente.

| Arquivo | Tamanho | Descrição |
| :--- | :--- | :--- |
| **`OpenCrosshairQ-Setup-0.2.2.exe`** | ~116 MB | Instalador completo do Windows. Cria atalhos no Menu Iniciar/Área de Trabalho e inclui assistente de desinstalação. |
| **`OpenCrosshairQ-Portable.exe`** | ~105 MB | Versão portátil. Sem necessidade de instalação: basta baixar, colocar em qualquer pasta e executar. |

### Verificação de Integridade (SHA-256)

Para conferir integridade dos binários baixados, compare o hash SHA-256 com `SHA256SUMS.txt` da mesma release no PowerShell. Hash não substitui assinatura do editor:
```powershell
Get-FileHash -Algorithm SHA256 OpenCrosshairQ-Setup-0.2.2.exe
Get-FileHash -Algorithm SHA256 OpenCrosshairQ-Portable.exe
```

Hashes de cada versão ficam no arquivo `SHA256SUMS.txt` anexado à respectiva release; não compare executáveis novos com hashes de versões anteriores.

> **Nota sobre o Windows SmartScreen:** Por se tratar de um projeto open-source novo sem certificado digital pago (EV Code Signing), o Windows Defender SmartScreen pode exibir um aviso azul na primeira execução. Basta clicar em **"Mais informações"** e depois em **"Executar assim mesmo"**. O código-fonte é 100% auditável neste repositório.

---

## Como Usar

1. **Inicie o aplicativo:** A janela principal será aberta e o ícone aparecerá na bandeja do sistema (System Tray).
2. **Escolha uma mira na biblioteca:** Navegue pela aba **Miras** ou clique no botão **Criador** para desenhar sua própria mira.
3. **Personalize:** Altere cores, espessura, opacidade, raio de abertura e animações no painel lateral direito.
4. **Atalhos Rápidos:**
   - `Alt+Shift+Z`: Oculta ou exibe o overlay da mira instantaneamente.
   - `Ctrl+Z` / `Ctrl+Y`: Desfaz e refaz alterações no Criador.
5. **Minimizar para a Bandeja:** Ao fechar a janela principal, o overlay continua ativo no seu jogo e o aplicativo fica minimizado na bandeja. Clique com o botão direito no ícone da bandeja para fechar completamente.

---

## Compilação a partir do Código-Fonte

Se preferir compilar o OpenCrosshairQ por conta própria:

### Pré-requisitos
- **Windows 10 ou 11 (x64)**
- **Node.js 20+**
- **Git**
- *Opcional:* Visual Studio Build Tools (C++) para recompilar o módulo nativo `crosshairq.node`

### Passo a passo
1. Clone o repositório:
   ```bash
   git clone https://github.com/quedinhadev/OpenCrosshairQ.git
   cd OpenCrosshairQ
   ```

2. Instale as dependências:
   ```bash
   npm install
   ```

3. (Opcional) Recompile o módulo C Win32:
   ```bash
   npm run build:native
   ```

4. Execute em modo de desenvolvimento:
   ```bash
   npm start
   ```

5. Execute a suíte de testes:
   ```bash
   npm test
   npm run test:native
   npm run test:electron
   ```
   No Windows, `npm run test:keybinds` testa main, hook e overlay com perfil temporário e teclas sintéticas raras. Não execute durante partidas. Mouse positivo e teclas físicas exigem validação manual. Para testar o payload empacotado, defina `CQ_TEST_APP_ROOT` com o caminho de `dist/win-unpacked/resources/app.asar`.

6. Gere os instaladores de produção (NSIS e Portable):
   ```bash
   npm run dist
   ```
   Os executáveis gerados ficarão disponíveis na pasta `dist/`, junto de `latest.yml` e `.blockmap` necessários ao atualizador NSIS. Depois, execute `node scripts/generate-release-metadata.cjs` para gerar `portable-update.json` e `SHA256SUMS.txt` a partir dos binários finais.

### Publicar atualização

O workflow `.github/workflows/release.yml` valida a tag contra `package.json`, testa, compila o addon e gera **release draft** com instaladores, metadados e hashes. Tag de exemplo: `v0.2.0`. Revise e publique o draft somente após validar os binários; drafts não chegam ao atualizador.

- Nunca inclua `GH_TOKEN` no aplicativo. Workflow usa token temporário do GitHub Actions apenas para publicar.
- Preserve `appId`, nome do produto e repositório entre versões. Não substitua arquivos de release publicada.
- `latest.yml` referencia instalador e hash SHA-512; publique também `.blockmap`. Não edite hashes manualmente.
- Sem certificado Authenticode, hash via HTTPS não comprova identidade do editor. Proteja conta GitHub e permissões de publicação; não desative verificações de assinatura do atualizador.
- Antes de distribuir, teste atualização entre duas versões NSIS em ambiente isolado, incluindo preservação de perfis, instalação cancelada e aplicativo na bandeja.

---

## Como Contribuir

O OpenCrosshairQ é construído para e pela comunidade. Toda ajuda é muito bem-vinda:
- Relate problemas ou bugs via [Issues](https://github.com/quedinhadev/OpenCrosshairQ/issues).
- Sugira novas ideias de customização ou novos presets de mira.
- Envie correções e melhorias de código via Pull Request seguindo as diretrizes em [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Licença

Distribuído sob a licença **MIT**. Veja [LICENSE](LICENSE) para mais detalhes.
