# Política de Segurança e Arquitetura Anti-Cheat

## Arquitetura de Segurança e Relação com Anti-Cheats

O **OpenCrosshairQ** foi projetado desde a primeira linha de código para operar de maneira **100% passiva, offline e transparente ao sistema operacional**.

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
5. **100% Offline e Sem Telemetria:**
   - O aplicativo não faz requisições a servidores externos.
   - Seus perfis e configurações são salvos localmente em `%APPDATA%\crosshairq`.
   - Não há coleta de telemetria, analytics ou identificadores do computador.

### Risco de Banimento perante Anti-Cheats (EAC, BattlEye, Vanguard, Ricochet, etc.)
Em termos técnicos, o OpenCrosshairQ funciona para o sistema exatamente como a funcionalidade de mira de hardware embutida em monitores gamer modernos: ele apenas desenha pixels por cima da tela da sua área de trabalho.

> **Importante:** Embora o OpenCrosshairQ não viole a integridade de arquivos de jogos nem injete código, verifique sempre os Termos de Serviço (ToS) específicos de cada jogo ou liga competitiva quanto ao uso de sobreposições visuais externas de terceiros.

---

## Relato Responsável de Vulnerabilidades

Se você encontrar qualquer vulnerabilidade de segurança no código, pedimos que relate de forma responsável:
1. Abra um relatório privado ou uma Issue marcada como segurança no GitHub.
2. Descreva o impacto técnico e passos para reprodução.
3. A equipe revisará o problema e lançará uma correção com menção de agradecimento.
