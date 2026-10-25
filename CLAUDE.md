# Istruzioni per Claude (minigiochi)

## Lingua

Rispondi sempre in italiano, anche nei commit, nelle PR e nei commenti al codice.

## Raspberry Pi: infrastruttura condivisa

Questa app gira su un Raspberry Pi 5 insieme ad altre app (Docker + Tailscale). L'elenco di tutto ciò che è già occupato sul Pi (porte, cartelle, progetti compose, container, reti e bridge, firewall, volumi, dispositivi e percorsi Tailscale, cron, nomi dei cookie) è nel file **`INFRASTRUTTURA-PI.md` della repo `Vito-Pepe/sillabe`**:
https://raw.githubusercontent.com/Vito-Pepe/sillabe/main/INFRASTRUTTURA-PI.md

- **Leggilo prima** di scegliere o cambiare porte, nomi, reti, volumi, `tailscale serve`/funnel, cron o firewall, e prima di dare comandi da eseguire sul Pi. Non dare per libero niente di ciò che elenca; nel dubbio fai lanciare all'utente i comandi della sua sezione 9 e lavora sul loro output.
- Se non riesci a scaricarlo, aggiungi la repo `Vito-Pepe/sillabe` alla sessione e leggilo da lì.
- **Tienilo aggiornato**: se il tuo lavoro aggiunge, cambia o toglie qualcosa di infrastrutturale sul Pi, aggiorna `INFRASTRUTTURA-PI.md` nella repo `Vito-Pepe/sillabe` (aggiungila alla sessione con accesso in scrittura) con una PR, e dai all'utente il link diretto. Fallo nello stesso lavoro, non "dopo".
- Mai `tailscale serve` sull'host del Pi per una nuova app: gli indirizzi HTTPS si aggiungono nella repo `Vito-Pepe/ingressi-https`.

## Come lavorare con l'utente

- Il Pi segue `main`. Lavora su un branch e apri una PR verso `main`; l'utente la unisce su GitHub con **"Create a merge commit"** e non cancella il branch. Dai sempre il **link diretto** della PR e, prima di chiedere di unirla, verifica che sia ancora aperta.
- Claude non può fare SSH sul Pi: prepara i comandi a blocchi, da incollare uno alla volta, con l'output atteso. Segreti solo nel `.env` sul Pi, mai su git.
- Claude non può creare repo su GitHub (403): se serve una repo nuova, chiedi all'utente di crearla (Public, con "Add a README file").
- Una repo nuova che girerà sul Pi deve avere anche lei un `CLAUDE.md` con queste istruzioni (copialo da una delle repo esistenti).
