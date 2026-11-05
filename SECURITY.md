# Política de Segurança e Arquitetura Anti-Cheat

## Arquitetura de Segurança e Relação com Anti-Cheats

O **OpenCrosshairQ** usa sobreposição externa ao jogo, com funcionamento offline-first e sem injeção no processo do jogo.

### Como o OpenCrosshairQ Funciona Tecnicamente
1. **Janela de Overlay Nativa do Windows:**
   - A sobreposição visual utiliza estilos padrão da API Win32 (`WS_EX_TOPMOST | WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_TOOLWINDOW`).
   - A janela não recebe foco e não captura cliques ou movimentos do mouse destinados ao jogo (click-through completo).
2. **Sem Injeção de Código:**
   - O aplicativo **NÃO injeta DLLs**, threads ou shellcode em processos de terceiros.
   - O aplicativo **NÃO utiliza hooks de renderização** (sem interceptação de DirectX, Vulkan ou OpenGL).
3. **Sem Acesso à Memória dos Jogos:**
   - O OpenCrosshairQ não abre handles com privilégios de leitura ou escrita (`PROCESS_VM_READ` ou `PROCESS_VM_WRITE`) em executáveis de jogos.
   - O executável não lê estados internos de partidas, posições de inimigos ou variáveis do jogo.
4. **Isolamento de Entrada:**
   - O suporte opcional a detecção de cliques usa a API nativa do Windows (Raw Input / XInput em modo escuta do dispositivo local), sem sintetizar teclas ou cliques falsos (sem macros e sem automação).
5. **Offline-First e Sem Telemetria:**
   - Miras e perfis funcionam offline e ficam no diretório `userData` do Electron.
   - A partir do código-fonte v0.2.0, instalações NSIS e Portable consultam GitHub Releases via HTTPS para verificar e baixar atualizações. Desenvolvimento não ativa atualização automática.
   - Reinício e aplicação exigem ação explícita; URLs de atualização não são controladas pelo renderer. NSIS usa `electron-updater`; Portable usa manifesto `portable-update.json`, download com limites e verificação SHA-256 antes da substituição, com backup do executável anterior.
   - Hashes não substituem assinatura Authenticode nem proteção da conta publicadora. Falta de permissão de escrita no diretório Portable deve gerar erro, sem elevar privilégios ou alterar proteções do Windows.
   - Códigos CQ2 são dados comprimidos, não scripts. Importação limita entrada a 2 MiB e saída a 20 MiB antes de validar camadas e recompilar SVG.
   - Não há coleta de telemetria, analytics ou identificadores do computador.

### Risco de Banimento perante Anti-Cheats (EAC, BattlEye, Vanguard, Ricochet, etc.)
Uma janela de software não é equivalente a uma mira física de monitor. Ausência de injeção não comprova aprovação por anti-cheats e não garante ausência de punição; regras e compatibilidade dependem de cada jogo e torneio.

> **Importante:** Embora o OpenCrosshairQ não viole a integridade de arquivos de jogos nem injete código, verifique sempre os Termos de Serviço (ToS) específicos de cada jogo ou liga competitiva quanto ao uso de sobreposições visuais externas de terceiros.

---

## Relato Responsável de Vulnerabilidades

Se você encontrar qualquer vulnerabilidade de segurança no código, pedimos que relate de forma responsável:
1. Abra um relatório privado ou uma Issue marcada como segurança no GitHub.
2. Descreva o impacto técnico e passos para reprodução.
3. A equipe revisará o problema e lançará uma correção com menção de agradecimento.
