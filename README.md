# Espelho — protótipo de compartilhamento de tela

## Executar localmente

1. Instale o Node.js 18 ou superior (apenas uma vez).
2. Dê dois cliques em `Iniciar Espelho.vbs`. Ele inicia o servidor em segundo plano e abre a página automaticamente.
3. Clique em **Compartilhar minha tela** e envie o link recém-gerado ao espectador.

Como alternativa, no diretório deste projeto, execute `npm start` e acesse `http://localhost:3000`.

## Publicar na internet

Hospede o projeto em um servidor Node com HTTPS e defina `PORT` se necessário. Para conexões confiáveis entre redes diferentes, configure um TURN (por exemplo, coturn) e substitua a constante `iceServers` em `public/app.js` pelas credenciais do seu serviço TURN.

Cada nova transmissão gera um token aleatório e invalida automaticamente o link anterior. Este é um protótipo 1:1: cada sessão suporta somente um transmissor e um espectador.
