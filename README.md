# Vitrine Certa

Painel de gestão de conteúdo e resultados de afiliados no Brasil.

## Funcionalidades
- Painel de cliques, vendas, comissão e conversão.
- Cadastro de produtos e links de afiliado para Shopee e Mercado Livre.
- Calendário editorial de 30 dias e biblioteca de roteiros.
- Gerador de link curto Shopee pela Open API, quando as credenciais estiverem configuradas.
- Busca de ofertas Shopee pela API e consulta de relatório de conversões disponíveis no backend.
- Exportação CSV e armazenamento local do catálogo e métricas manuais.

## Publicar o servidor gratuitamente no Render
O GitHub Pages não executa o backend e não pode guardar credenciais secretas. Publique pelo Render usando o Blueprint deste repositório:

1. Entre em https://render.com/ e conecte o GitHub.
2. Crie um **Blueprint** e selecione este repositório.
3. O Render lerá `render.yaml` e criará o serviço web.
4. Nas variáveis de ambiente do serviço, configure `SHOPEE_APP_ID`, `SHOPEE_APP_SECRET` e `DASHBOARD_API_TOKEN`. Insira os valores diretamente no painel privado do Render — nunca no GitHub, no HTML ou no chat.
5. Aguarde o deploy. O painel e as rotas `/api/*` serão servidos pelo mesmo endereço.

O plano gratuito do Render pode suspender o serviço após inatividade; a primeira abertura depois disso pode demorar. Consulte as condições atuais do plano antes de depender de sincronizações agendadas.

## Shopee
O backend assina as requisições no servidor com SHA-256 e usa a Open API Affiliate GraphQL da Shopee. Rotas implementadas:
- `GET /api/status`
- `POST /api/shopee/short-link` com `originUrl` e `subIds`
- `GET /api/shopee/products?keyword=...&page=1&limit=20`
- `GET /api/shopee/conversions?start=UNIX_SECONDS&end=UNIX_SECONDS`

A disponibilidade de campos e operações depende da versão e permissões liberadas pela Shopee. A API pode recusar operações ou campos não habilitados para a conta. O painel deve ser validado com suas credenciais antes de considerar a integração operacional.

## Mercado Livre
O catálogo aceita links de afiliado gerados no painel oficial do Mercado Livre. Não implementamos acesso por cookies, senha ou sessão do navegador. Não há API pública de afiliados documentada e confirmada para consulta direta de comissões nesta versão; métricas do Mercado Livre devem ser inseridas manualmente ou importadas de relatórios exportados quando essa função for adicionada.

## Segurança
- Nunca adicione credenciais ao repositório público.
- As credenciais Shopee são lidas exclusivamente de variáveis de ambiente do backend.
- Não compartilhe App Secret, senha da conta, cookies ou tokens em conversas.
- Se um segredo for publicado acidentalmente, revogue-o/regenere-o na Shopee.
- As rotas privadas da Shopee exigem `DASHBOARD_API_TOKEN`. Informe o mesmo token no campo privado da tela de conexões; ele permanece apenas na sessão atual do navegador. O frontend guarda os dados de catálogo e métricas no armazenamento local do navegador; faça backup CSV.

## Observações
Os produtos de exemplo são apenas ideias de pesquisa, não ofertas verificadas. Confirme preço final com frete, estoque, reputação, avaliações, prazos e comissão nos marketplaces antes de divulgar.
