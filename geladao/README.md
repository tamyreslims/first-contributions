# 🧊 Geladão

Sistema de controle para geladão: estoque, entradas de mercadoria, vendas (PDV), perdas, despesas e acerto entre sócios.
Funciona no navegador do celular ou do computador, com vários aparelhos ao mesmo tempo.

## Como rodar

Precisa do [Node.js](https://nodejs.org) **22.13 ou mais novo**. Não tem nenhuma dependência para instalar.

```bash
cd geladao
npm start
```

O terminal mostra os endereços de acesso:
- no computador: `http://localhost:3000`
- nos celulares (no mesmo Wi-Fi): `http://IP-DO-COMPUTADOR:3000`

Os dados ficam em `geladao/dados/geladao.db`. **Faça cópia desse arquivo** para ter backup.

Variáveis opcionais: `PORT` (porta, padrão 3000), `DB_FILE` (caminho do banco) e
`SESSAO_MINUTOS` (tempo sem uso até bloquear a tela, padrão 10).

## Acesso com PIN

- No **primeiro uso**, cadastre o primeiro sócio e crie o PIN dele (4 números).
- Cada pessoa entra tocando no nome e digitando o PIN. Quem cadastra pessoas é um sócio, que já define o PIN inicial.
- **Bloqueio automático** depois de 10 minutos sem uso. Basta digitar o PIN para continuar de onde parou (a venda em andamento é mantida).
  Tocar no nome no topo da tela também bloqueia na hora.
- **5 PINs errados** bloqueiam aquela pessoa por 5 minutos.
- Esqueceu o PIN? Um sócio define um novo em *Mais › Sócios e vendedores › Editar*.
- Cada um pode trocar o próprio PIN em *Mais › Trocar meu PIN*.
- Pessoas cadastradas antes do PIN existir criam o PIN no primeiro acesso.
- O PIN é guardado criptografado (scrypt), e as permissões são checadas no servidor.

| Pode fazer | Vendedor | Sócio |
|---|:---:|:---:|
| Vender, abrir e fechar caixa, reforço de troco | ✅ | ✅ |
| Ver estoque (quantidade, preço e validade) | ✅ | ✅ |
| Ver custo, lucro e margem | ❌ | ✅ |
| Sangria e cancelar venda | ❌ | ✅ |
| Entradas, perdas, despesas e cadastros | ❌ | ✅ |
| Relatórios, acerto entre sócios e planilha | ❌ | ✅ |

## Funcionalidades

| Tela | O que faz |
|---|---|
| **Caixa** | Abertura com fundo de troco, sangria (retirada) e reforço de troco, fechamento com contador de cédulas e moedas. Mostra o esperado na gaveta e a diferença (sobra ou falta). Pix, débito e crédito podem ser conferidos com a maquininha. Guarda o histórico de fechamentos. |
| **Vender** | Toque nos produtos, ajuste a quantidade, aplique desconto e escolha o pagamento (dinheiro com troco, Pix, débito, crédito ou dividido). A venda baixa o estoque. |
| **Estoque** | Quantidade, custo, lucro por unidade, margem e próxima validade. Alertas de estoque baixo e de vencimento (7 dias). Registro de perdas (vencido, quebrado, consumo). |
| **Entrada** | Compra com vários produtos, quem pagou (sócio), forma de pagamento, validade de cada item e custos extras. Mostra o custo final e o lucro por unidade antes de salvar. |
| **Relatórios** | Faturamento, custo, lucro bruto, perdas, despesas e **lucro final**. Caixa por forma de pagamento, vendas por vendedor, mais vendidos, acerto entre sócios e histórico de vendas (com cancelamento). Botão **⬇ Planilha de estoque** (Excel). |
| **Mais** | Caixa, cadastro de produtos, sócios/vendedores, tipos de custo extra e despesas gerais. |

## Regras de cálculo

- **Custos extras de uma compra** (frete, gelo...) são divididos entre os produtos da compra, proporcional ao valor de cada um.
  Exemplo: R$ 72 de cerveja + R$ 12 de água + R$ 8,40 de frete → cerveja absorve R$ 7,20 e água R$ 1,20.
- **Custo final da unidade** = custo pago + parte dos custos extras.
- **Saída por validade (FEFO)**: a venda sempre tira primeiro do lote que vence antes. O custo da venda é o custo real dos lotes usados.
- **Lucro final** = vendas − custo das mercadorias vendidas − perdas − despesas gerais.
- **Acerto entre sócios**: soma o que cada sócio pagou (compras + despesas) e compara com a parte igual de cada um.
- **Cancelar venda** devolve os produtos aos mesmos lotes. Venda de caixa já fechado não pode ser cancelada.
- **Caixa**: só se vende com caixa aberto, e só existe um caixa aberto por vez.
  Dinheiro esperado na gaveta = fundo de troco + vendas em dinheiro + reforços − sangrias.
- Valores são guardados em centavos para evitar erros de arredondamento.

## Planilha de estoque (Excel)

Em **Relatórios**, escolha o período e toque em **⬇ Planilha de estoque**. O arquivo `.xlsx` tem 3 abas:

1. **Estoque atual**: quantidade, mínimo, situação, custo médio, preço, lucro/un., margem, valor parado (custo e venda) e próxima validade.
2. **Movimento no período**: por produto, estoque inicial, entradas, vendidos, perdas e estoque final, com custo, faturamento e lucro.
3. **Lotes e validades**: cada lote com saldo, quem pagou, custo pago + custos extras, validade e dias para vencer.

Abre no Excel, no Google Planilhas e no LibreOffice, com filtros, cabeçalho fixo e configuração para impressão em paisagem.

## Testes

```bash
npm test
```

## Estrutura

```
geladao/
├── src/
│   ├── db.js        # tabelas SQLite
│   ├── logica.js    # regras de negócio
│   ├── planilhas.js # dados das planilhas
│   ├── xlsx.js      # gerador de Excel (sem dependências)
│   └── server.js    # servidor HTTP + API
├── public/          # app web (HTML/CSS/JS)
└── test/            # testes automatizados
```

## Próximos passos sugeridos

- Hospedar na nuvem para acessar fora do Wi-Fi
- Leitor de código de barras (quando tiver o leitor)
- Mais planilhas (vendas, entradas, caixa, sócios)
