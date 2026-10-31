# OpenCrosshairQ — Q Aberto / kit 1.0

Seleção do usuário: conceito A. Data: 2026-10-26. Geometria do símbolo original preservada; letterforms do wordmark desenhados para este kit, em paths SVG, sem fontes externas. Não foram copiados logos existentes. Originalidade jurídica não verificada: pesquisa de marca/trademark na classe 9 pendente antes de uso oficial.

## Paleta oficial

| Papel | HEX | Uso |
|---|---|---|
| Azul base | `#246BFD` | Símbolo principal, assinatura e fundo do app icon |
| Azul escuro | `#174BCC` | Apoio em superfícies claras; não substituir o azul do logo sem necessidade |
| Azul claro | `#EAF0FF` | Superfície de apoio, nunca símbolo pequeno sobre branco |
| Mono escuro | `#111111` | Tray em superfície clara, impressão mono |
| Reverso | `#FFFFFF` | Símbolo/assinatura em superfícies escuras ou azul base |

Azul base/branco: contraste aproximado 4,5:1; logo não substitui cor de texto acessível. Para UI, medir contraste específico de texto, estado e fundo. Sem gradientes, sombras, glow, contornos adicionais ou distorção.

## Arquivos e aplicação

Todos os assets finais têm espelho em `app/assets/brand/` e `analysis/ux-rework-20261026/brand/`. Conceitos B/C e arquivos `concept-*` permanecem apenas como histórico, não como alternativas oficiais.

| Arquivo | Aplicação |
|---|---|
| `icon-a-blue.svg` | Símbolo vetorial principal, fundo claro |
| `icon-a-dark.svg` | Mono escuro transparente, tray claro e impressão |
| `icon-a-white.svg` | Branco transparente, tray escuro e uso dark |
| `icon-a-app.svg` | Quadrado azul cheio com Q branco, Windows; sem cantos pré-arredondados |
| `icon-a-{blue,dark,white,app}-{16,24,32,48,64,128,256}.png` | Rasterizações nativas. Tray: 16/24/32 conforme DPI; app: 256 |
| `icon-a-windows.ico` | App Windows, atalhos e installer; 16/24/32/48/64/128/256, PNGs no contêiner ICO |
| `favicon.ico` | Site/README publicado na web; 16/32/48, símbolo azul transparente |
| `wordmark-full-horizontal-{blue,dark,white}.svg` | README, cabeçalho, About e comunicação com nome completo |
| `wordmark-full-vertical-{blue,dark,white}.svg` | Capa, splash e comunicação com espaço vertical |
| `wordmark-compact-horizontal-{blue,dark,white}.svg` | Assinatura CQ em espaços curtos, produto já identificado |
| `wordmark-compact-vertical-{blue,dark,white}.svg` | CQ empilhado com símbolo, badges maiores |
| `kit-contact-sheet.png` / `.html` | Revisão visual, incluindo prova nativa a 16 px |
| `kit-validation.json` | Resultado dos asserts, dimensões e hashes dos ícones de produção |

## Regras de uso

- Usar somente Q isolado em 16 px. Anel de 32 unidades equivale a 2 px nessa escala. Abertura e cauda devem continuar distintas; não comprimir ou afinar.
- Wordmark horizontal completo: largura mínima 240 px; compacto: 112 px. Vertical completo: 280 px; compacto: 112 px. Abaixo disso, usar símbolo.
- Área livre mínima: 32 unidades ao redor do símbolo (1/8 do viewBox), 16 unidades ao redor do lockup. Não incluir outras marcas nessa área. App icon cheio é exceção de enquadramento.
- Preservar proporção e orientação. Branco sobre superfície escura; escuro/azul sobre clara. Evitar fotografia ou fundo de baixo contraste sem área sólida de apoio.
- Wordmarks usam caminhos geométricos com stroke explícito e fixo; não dependem de fonte instalada. Não alterar stroke-width nem adicionar `vector-effect`.

## Aplicação em produção — ainda não executada

`app/assets/icon.png`, `app/assets/icon.ico` e `app/build/icon.ico` não são destinos deste kit. Coordenador aplicará após confirmação do usuário. Candidatos: `icon-a-app-256.png` para ícone PNG; `icon-a-windows.ico` para app/installer; mono transparente para tray. Não substituir tray por quadrado cheio sem testar estados claro/escuro do Windows.

## Reprodução e validação

Sem dependências novas, sem ffmpeg, sem rede. Executar da raiz do projeto:

```powershell
& .\app\node_modules\electron\dist\electron.exe .\analysis\ux-rework-20261026\brand\build-kit.cjs
```

Electron isolado, `userData` em `%LOCALAPPDATA%\Temp\opencode\ocq-brand-kit-electron`. Canvas rasteriza SVG diretamente em cada tamanho; ICO montado em Node com PNGs embutidos. Asserts validam dimensões PNG, diretório ICO, SVGs sem elementos ativos/links/gradientes e hashes inalterados dos ícones de produção. Revisar `kit-contact-sheet.png` visualmente antes de aplicar.
