# OpenCrosshairQ

<p align="center">
  <img src="assets/brand/wordmark-full-horizontal-blue.svg" alt="OpenCrosshairQ Logo" width="480">
</p>

<p align="center">
  <strong>Mira externa de alta precisão, gratuita, open-source e 100% offline-first para Windows.</strong><br>
  Uma alternativa livre e segura ao CrosshairX, sem risco de banimento por anti-cheat e sem telemetria.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License MIT">
  <img src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D6.svg" alt="Windows Platform">
  <img src="https://img.shields.io/badge/tests-266%20passing-brightgreen.svg" alt="Tests 266 Passing">
  <img src="https://img.shields.io/badge/electron-45.0.0-47848F.svg" alt="Electron">
  <img src="https://img.shields.io/badge/offline--first-100%25-success.svg" alt="Offline-First">
</p>

---

## Sumário

- [Por que OpenCrosshairQ?](#por-que-opencrosshairq)
- [Segurança e Anti-Cheat](#segurança-e-anti-cheat)
- [Principais Funcionalidades](#principais-funcionalidades)
- [Download e Instalação (Release v0.1.0)](#download-e-instalação-release-v010)
- [Como Usar](#como-usar)
- [Compilação a partir do Código-Fonte](#compilação-a-partir-do-código-fonte)
- [Como Contribuir](#como-contribuir)
- [Licença](#licença)

---

## Por que OpenCrosshairQ?

Muitos softwares comerciais de miras cobram assinaturas ou valores altos, exigem conexão contínua com a internet, exibem anúncios ou utilizam métodos invasivos de injeção que podem disparar alertas falsos em sistemas anti-cheat.

O **OpenCrosshairQ** foi criado pela comunidade para ser:
1. **100% Gratuito e Código Aberto:** Todo o código é aberto sob licença MIT. Sem paywalls, sem assinaturas.
2. **Offline-First e Privativo:** Não envia dados para a nuvem, não exige login e não possui rastreadores ou telemetria.
3. **Leve e Otimizado:** Desenvolvido em Electron com aceleração gráfica acelerada e módulo nativo C Win32 para consumo mínimo de CPU/GPU.
4. **Precisão de Pixel:** Renderização matemática de subpixel com compensação para monitores de alto DPI e taxas de atualização elevadas.

---

## Segurança e Anti-Cheat

### O OpenCrosshairQ pode causar banimento?
**Não.** O OpenCrosshairQ opera de forma **100% passiva e externa**:
- **Zero injeção de DLLs ou threads** em jogos.
- **Zero leitura ou gravação de memória** de processos externos (`PROCESS_VM_READ` ou `PROCESS_VM_WRITE`).
- **Zero hooking de gráficos** (não intercepta chamadas de DirectX, Vulkan ou OpenGL).
- O overlay é uma janela padrão do Windows com propriedades nativas transparentes (`WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_TOOLWINDOW`). Todos os cliques passam diretamente para o jogo abaixo (click-through nativo).

Para os sistemas anti-cheat (como Vanguard, EAC, BattlEye e Ricochet), o OpenCrosshairQ é tecnicamente indistinguível da mira física embutida nos monitores gamer modernos.

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
- **Atalhos Globais:**
  - Oculte ou exiba a mira a qualquer momento via tecla de atalho (`Alt+Shift+Z` padrão, configurável).
- **Modo Streamer (OBS / XSplit):**
  - Servidor HTTP local seguro em `127.0.0.1` para capturar a mira via *Browser Source* no OBS Studio sem poluir a sua gravação com janelas do desktop.
- **Suporte Multimonitor e DPI Dinâmico:**
  - Alinhamento automático ao centro geométrico físico com suporte a escalas de 100%, 125%, 150%, 200% e multitelas.

---

## Download e Instalação (Release v0.1.0)

Acesse a página de [Releases](https://github.com/quedinhadev/OpenCrosshairQ/releases) para baixar a versão mais recente.

| Arquivo | Tamanho | Descrição |
| :--- | :--- | :--- |
| **`OpenCrosshairQ-Setup-0.1.0.exe`** | ~116 MB | Instalador completo do Windows. Cria atalhos no Menu Iniciar/Área de Trabalho e inclui assistente de desinstalação. |
| **`OpenCrosshairQ-Portable.exe`** | ~105 MB | Versão portátil. Sem necessidade de instalação: basta baixar, colocar em qualquer pasta e executar. |

### Verificação de Integridade (SHA-256)

Para garantir a autenticidade dos binários baixados, compare o hash SHA-256 no PowerShell:
```powershell
Get-FileHash -Algorithm SHA256 OpenCrosshairQ-Setup-0.1.0.exe
Get-FileHash -Algorithm SHA256 OpenCrosshairQ-Portable.exe
```

Hashes oficiais da versão v0.1.0:
- `OpenCrosshairQ-Setup-0.1.0.exe`: `1f4048084a9950a53797cff60230f821d4423b5eddcd94748a44bb5137b7914d`
- `OpenCrosshairQ-Portable.exe`: `9525835f955a24094040ae9c3e1e0798a26ed1aa3dd8ffc5afa5db8a230d0dcb`

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

5. Execute a suíte de testes (266 testes):
   ```bash
   npm test
   ```

6. Gere os instaladores de produção (NSIS e Portable):
   ```bash
   npm run dist
   ```
   Os executáveis gerados ficarão disponíveis na pasta `dist/`.

---

## Como Contribuir

O OpenCrosshairQ é construído para e pela comunidade. Toda ajuda é muito bem-vinda:
- Relate problemas ou bugs via [Issues](https://github.com/quedinhadev/OpenCrosshairQ/issues).
- Sugira novas ideias de customização ou novos presets de mira.
- Envie correções e melhorias de código via Pull Request seguindo as diretrizes em [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Licença

Distribuído sob a licença **MIT**. Veja [LICENSE](LICENSE) para mais detalhes.
