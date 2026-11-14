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

Variáveis opcionais: `PORT` (porta, padrão 3000) e `DB_FILE` (caminho do banco).

## Funcionalidades

| Tela | O que faz |
|---|---|
| **Vender** | Toque nos produtos, ajuste a quantidade, aplique desconto e escolha o pagamento (dinheiro com troco, Pix, débito, crédito ou dividido). A venda baixa o estoque. |
| **Estoque** | Quantidade, custo, lucro por unidade, margem e próxima validade. Alertas de estoque baixo e de vencimento (7 dias). Registro de perdas (vencido, quebrado, consumo). |
| **Entrada** | Compra com vários produtos, quem pagou (sócio), forma de pagamento, validade de cada item e custos extras. Mostra o custo final e o lucro por unidade antes de salvar. |
| **Relatórios** | Faturamento, custo, lucro bruto, perdas, despesas e **lucro final**. Caixa por forma de pagamento, vendas por vendedor, mais vendidos, acerto entre sócios e histórico de vendas (com cancelamento). |
| **Mais** | Cadastro de produtos, sócios/vendedores, tipos de custo extra e despesas gerais. |

## Regras de cálculo

- **Custos extras de uma compra** (frete, gelo...) são divididos entre os produtos da compra, proporcional ao valor de cada um.
  Exemplo: R$ 72 de cerveja + R$ 12 de água + R$ 8,40 de frete → cerveja absorve R$ 7,20 e água R$ 1,20.
- **Custo final da unidade** = custo pago + parte dos custos extras.
- **Saída por validade (FEFO)**: a venda sempre tira primeiro do lote que vence antes. O custo da venda é o custo real dos lotes usados.
- **Lucro final** = vendas − custo das mercadorias vendidas − perdas − despesas gerais.
- **Acerto entre sócios**: soma o que cada sócio pagou (compras + despesas) e compara com a parte igual de cada um.
- **Cancelar venda** devolve os produtos aos mesmos lotes.
- Valores são guardados em centavos para evitar erros de arredondamento.

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
│   └── server.js    # servidor HTTP + API
├── public/          # app web (HTML/CSS/JS)
└── test/            # testes automatizados
```

## Próximos passos sugeridos

- Login com PIN por vendedor
- Fechamento de caixa diário (conferência de dinheiro)
- Hospedar na nuvem para acessar fora do Wi-Fi
- Leitor de código de barras (quando tiver o leitor)
- Exportar relatórios para planilha
