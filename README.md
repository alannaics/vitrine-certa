# Vitrine Certa 2.0

Plataforma de curadoria de ofertas de afiliados, com painel administrativo, vitrine pública, rastreamento de cliques e apoio à produção de conteúdo.

## Funcionalidades

- Painel principal em `/` e `/v2`.
- Vitrine e gestão de ofertas em `/ofertas`.
- Cadastro, edição, publicação e despublicação de ofertas, com links HTTPS fornecidos pelo administrador.
- Redirecionamento rastreado em `/go/:id`, sem coleta de IP ou cookies para essa contagem.
- Relatório protegido de cliques em `/api/v2/clicks`.
- Financeiro com registros manuais de comissões efetivamente recebidas e despesas.
- Integrações externas opcionais; nenhuma fonte de produtos é considerada afiliada sem autorização e atribuição comprovada.

## Implantação

Aplicação Node.js/Express com PostgreSQL. Configure `DATABASE_URL` e `DASHBOARD_API_TOKEN` no ambiente privado do Render. Não compartilhe tokens, senhas ou segredos em código, capturas de tela ou mensagens.

Para usar o gerador de conteúdo, configure as credenciais correspondentes ao provedor de IA já integrado no backend.

## Limitações

O sistema registra cliques, não vendas. Links cadastrados não são verificados automaticamente quanto à elegibilidade de comissão, disponibilidade ou preço. Publicação automática em redes sociais exige autorização específica dos respectivos canais. Não há promessa de lucro.

## Desenvolvimento

`npm install` e `npm run check` para verificações disponíveis no projeto.
