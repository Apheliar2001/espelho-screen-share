# Apheliar Screen — compartilhamento de tela

## Executar localmente

1. Instale o Node.js 18 ou superior (apenas uma vez).
2. Dê dois cliques em `Iniciar Espelho.vbs`. Ele inicia o servidor em segundo plano e abre a página automaticamente.
3. Clique em **Compartilhar minha tela** e envie o link recém-gerado ao espectador.

Como alternativa, no diretório deste projeto, execute `npm start` e acesse `http://localhost:3000`.

## Publicar na internet

Hospede o projeto em um servidor Node com HTTPS e defina `PORT` se necessário. Para conexões confiáveis entre redes diferentes, configure um TURN (por exemplo, coturn) e substitua a constante `iceServers` em `public/app.js` pelas credenciais do seu serviço TURN.

Cada nova transmissão gera um token aleatório e invalida automaticamente o link anterior. Cada sessão suporta um transmissor e até 10 espectadores simultâneos. Como a imagem é enviada diretamente pelo navegador do transmissor, a qualidade para todos depende principalmente da conexão de upload dele.
