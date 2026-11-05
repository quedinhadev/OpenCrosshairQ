# Changelog

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
