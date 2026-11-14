# Changelog

## v0.2.2

### Atalhos

- Reconhecimento de Ctrl, Alt e Shift dos dois lados do teclado, inclusive em combinações remapeadas.
- Mouse respeita ativação e botão configurado; alterações de perfil limpam estado transitório da mira e das animações.
- Ações centralizadas no processo principal evitam duplicação; taps curtos preservam suas bordas entre leituras do hook.
- Captura de atalhos suspende ações e atalho global; tecla mantida exige soltura antes de nova ativação.
- Autorepeat não gera novas ações; falha de mouse ou controle não invalida a outra fonte saudável.
- Interface mostra atalhos desativados e oferece ativação explícita de Mirar, Atirar e Recarregar, sem mudar o atalho global nem configurações pessoais silenciosamente.
- Captura de botão esquerdo/direito do mouse na interface; texto explica quando Atirar e Recarregar têm efeito em camadas animadas.

### Interface

- Sons opcionais para botões, navegação, seletores, sliders, modais e controles do Criador, com preferência persistida, deduplicação e volume discreto.
- Sem sons de hover ou de atalhos durante jogo/background.
- Hierarquia, espaçamento, foco e contraste refinados; estado desligado neutro.
- Transições curtas de páginas e mensagens, respeitando redução de movimento.

### Validação e distribuição

- Harness Windows isolado testa hook, main e overlay com teclas sintéticas raras; não faz parte do aplicativo distribuído.
- Pipeline verifica ciclo de vida do addon e paridade das fontes e addon no pacote final.
- Configuração do perfil ativo recebe registro de recuperação na gravação atômica das preferências, preservando alterações antes do salvamento adiado do perfil.
- Teste sintético não substitui validação física, compatibilidade com jogos/anti-cheats ou atualização NSIS ponta a ponta.

## v0.2.1

- Ligação dos atalhos remapeáveis de teclado ao overlay por hook passivo do Windows.
- Correção do download explícito do Electron no pipeline de release.

## v0.2.0

### Novidades

- Compartilhamento de miras por códigos CQ2 compactos, offline e sem conta, com compatibilidade CQ1/JSON.
- Importação diretamente para favoritos, preservando formato existente, nomes com Unicode e camadas.
- Atualizações automáticas em segundo plano para Windows NSIS e Portable; aplicação e reinício exigem confirmação.
- Painel de atualização com status, progresso e verificação manual em português e inglês.

### Correções e proteção de dados

- Miras vazias permanecem vazias ao compartilhar/importar.
- Bloqueio de importações simultâneas e validação estrita de códigos, com cotas de entrada e descompressão.
- Persistência de perfis e configurações antes de aplicar atualização.
- Atualização Portable com SHA-256, substituição do executável e backup; sem instalar aplicativo ou elevar privilégios.
- Canais IPC de atualização restritos ao frame principal da interface.

### Distribuição

- Releases incluem instalador, Portable, metadados dos atualizadores e `SHA256SUMS.txt`.
- Workflow por tag valida versão e cria draft para revisão, sem sobrescrever releases existentes.

### Compatibilidade

- Usuários da v0.1.0 precisam baixar esta versão manualmente para receber o atualizador.
- Portable exige permissão de escrita na pasta do executável; desenvolvimento não verifica atualizações automaticamente.
- Executáveis sem assinatura Authenticode podem gerar avisos do Windows SmartScreen.
- Overlay externo não garante imunidade a anti-cheat. Respeite regras de cada jogo.
