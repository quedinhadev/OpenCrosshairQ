# Guia de Contribuição — OpenCrosshairQ

Obrigado por querer colaborar com o **OpenCrosshairQ**! Este é um projeto comunitário de código aberto sob licença MIT, criado para oferecer aos jogadores e criadores de conteúdo uma ferramenta de mira customizada de nível profissional, gratuita, offline e sem riscos de banimento.

Toda ajuda é bem-vinda: correção de bugs, novos recursos, melhorias visuais, documentação ou sugestões de mira.

---

## Estrutura do Código

```
app/
├── assets/          # Ícones, logo oficial e guia de marca
├── build/           # Recursos de empacotamento (.ico, .png)
├── native/          # Módulo C nativo Win32 (Raw Input, XInput, foreground)
│   ├── crosshairq.c
│   └── build.ps1
├── src/
│   ├── designer/    # Criador visual de miras (HTML/CSS/JS + SVG/Canvas)
│   ├── main/        # Processo principal Electron (janelas, IPC, perfis, tray)
│   ├── overlay/     # Renderizador transparente de alta taxa de quadros
│   ├── shared/      # Geometria, histórico (undo/redo), camadas e regras
│   └── ui/          # Shell principal (Miras, Atalhos, Posições, Configurações)
└── test/            # Suíte de testes automatizados (266+ testes unit e integração)
```

---

## Como Configurar o Ambiente de Desenvolvimento

### Pré-requisitos
- **Windows 10 ou 11 (64-bit)**
- **Node.js 20+** instalado
- **Visual Studio Build Tools C++** (opcional, necessário apenas se recompilar o módulo nativo C)

### Passos de Instalação
1. Clone o repositório:
   ```bash
   git clone https://github.com/diogodsgnr/OpenCrosshairQ.git
   cd OpenCrosshairQ
   ```
2. Instale as dependências:
   ```bash
   npm install
   ```
3. (Opcional) Compile o módulo nativo C Win32:
   ```bash
   npm run build:native
   ```
4. Inicie o aplicativo em modo de desenvolvimento:
   ```bash
   npm start
   ```

---

## Rodando os Testes

O projeto conta com mais de 260 testes automatizados cobrindo geometria vetorial, histórico, regras de perfil, IPC e sanidade de renderização.

- Rodar todos os testes unitários:
  ```bash
  npm test
  ```
- Rodar o teste de fumaça completo do Electron:
  ```bash
  npm run test:electron
  ```
- Rodar o smoke do módulo nativo:
  ```bash
  npm run test:native
  ```

---

## Boas Práticas e Padrões de Código

- **Offline-First:** O app não deve realizar conexões com a internet sem ação explícita do usuário.
- **Zero Gambiarras:** Soluções limpas, sem injeção de dependências pesadas onde poucas linhas de JavaScript/C puro resolvem.
- **Respeito aos Testes:** Novos recursos ou correções de bug devem vir acompanhados de testes automatizados na pasta `test/`.
- **Desempenho de Renderização:** O overlay precisa consumir o mínimo possível de CPU e GPU para não afetar o frametime dos jogos.

---

## Como Enviar um Pull Request

1. Crie uma branch para a sua alteração:
   ```bash
   git checkout -b feat/minha-melhoria
   ```
2. Faça commits descritivos seguindo o padrão convencional:
   - `feat: adiciona camada de gradiente radial no designer`
   - `fix: corrige offset em monitores com escalonamento fracionário de DPI`
   - `docs: atualiza instruções de compilação no Windows`
3. Certifique-se de que todos os testes passem:
   ```bash
   npm test
   ```
4. Envie a branch para o seu fork e abra o Pull Request detalhando o que foi feito!
