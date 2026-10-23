# minigiochi

Raccolta di minigiochi HTML per bambini, servita da nginx in un container Docker sul Raspberry Pi. È la stessa sezione "Giochi" della homepage, ma in un'app a sé: giochi, gruppi e password sono separati da quelli della homepage.

- Pagina: `http://IP-DEL-PI:8085` dalla rete di casa, `http://<nome>.<tailnet>.ts.net:8085` (o `http://vito:8085`) dalla tailnet.
- Link per i genitori: `https://parole-esercizi.<tailnet>.ts.net/m/<codice>`, da qualsiasi telefono.

## Aggiungere un gioco

L'elenco si costruisce da solo con i giochi presenti in `app/files/`: per aggiungerne uno basta mettere lì il suo file `.html`, senza modificare nessun elenco.

- **Nome nell'elenco**: il `<title>` del gioco. Se manca, si usa il nome del file (`memory-animali.html` diventa "Memory animali").
- **Icona** (facoltativa): `<meta name="icona" content="🐶">` nel `<head>`. Se manca: 🎮.
- **Descrizione** (facoltativa): `<meta name="description" content="Trova le coppie">`.
- Consigliato: un link per tornare all'elenco, `<a href="../">← Giochi</a>`.

Se un gioco usa immagini o altri file, vanno nella stessa cartella: nell'elenco compaiono solo i `.html`.

Per pubblicarne uno senza usare il terminale: su GitHub apri la cartella `app/files`, premi **Add file > Upload files**, trascina il file e conferma su `main`. Entro 5 minuti il Pi lo mostra.

In cima all'elenco c'è una **barra di ricerca**: filtra i giochi per nome (titolo o nome del file) mentre si scrive, senza badare a maiuscole e accenti.

## Caricare un gioco dalla pagina

In fondo alla pagina c'è il link **Gestisci giochi**: con la password si può caricare un file `.html`, che compare subito nell'elenco, oppure eliminare un gioco caricato (la ✕ sul suo riquadro). I giochi caricati così stanno **solo sul Pi** (volume Docker `minigiochi_giochi-caricati`, servito da nginx su `/caricati/`), non su GitHub. Quelli in `app/files/` restano gestiti dalla repo e non si possono eliminare dalla pagina.

Il caricamento passa da un piccolo servizio Node (`uploader/`, servizio `giochi` nel compose) che nginx raggiunge su `/api/`: accetta solo file `.html` fino a 3 MB, pulisce il nome del file e chiede la password, con blocco di un minuto dopo 5 tentativi sbagliati. Senza password impostata il caricamento resta spento.

## Gruppi di giochi (link per i genitori)

Per mandare dei giochi a un genitore si crea un **gruppo** in "Gestisci giochi" (sezione "Gruppi di giochi"): nome interno (mai il nome del paziente), giochi scelti tra quelli presenti, anche uno solo. Ogni gruppo ha un **link pubblico** con "Copia link", "Modifica" ed "Elimina"; da "Modifica" c'è anche "Nuovo link", che disattiva quello vecchio.

Chi apre il link, da qualsiasi telefono e senza Tailscale:
- con **più giochi** vede una pagina di scelta (titolo, icona e descrizione presi dai giochi);
- con **un gioco solo** va dritto al gioco.

I giochi sono serviti in **sandbox**: gli script funzionano, ma il gioco non può salvare dati nel browser né vedere cookie o altre pagine. A ogni gioco viene aggiunto al volo un piccolo script per i link che portano fuori dal gioco (es. "← Giochi"): con più giochi riportano alla pagina di scelta del gruppo, con un gioco solo vengono nascosti. I file dei giochi non vengono modificati.

Eliminando un gioco, viene tolto anche dai gruppi; un gruppo rimasto senza giochi ha il link disattivato.

Tutto questo lo serve la seconda porta del servizio `giochi` (`127.0.0.1:8086`, visibile solo sul Pi), che risponde solo a un codice di gruppo valido (casuale, 128 bit). Esce su Internet dall'ingresso pubblico di Parole (`parole-esercizi`, percorso `/m/`, configurato nella repo parole). I gruppi stanno nel volume `minigiochi_giochi-stato`, separato dai giochi.

Limite: un gioco pubblicato deve stare in un solo file (immagini incorporate o prese da Internet).

## Differenze dalla sezione Giochi della homepage

Il codice è lo stesso della homepage (`app/giochi/` e `uploader/` di quella repo), con tre differenze nel servizio:

| | homepage | minigiochi |
|---|---|---|
| Indirizzo della gestione | `/giochi/api/` | `/api/` |
| Cookie di accesso | `giochi` | `minigiochi` (i cookie non distinguono le porte: nomi diversi evitano che entrare in una pagina faccia uscire dall'altra) |
| Percorso dei link pubblici | `/g/` | `/m/` |

Una correzione al codice dei giochi va fatta in entrambe le repo.

## Installazione sul Raspberry Pi

```bash
cd ~
git clone https://github.com/Vito-Pepe/minigiochi.git
cd minigiochi
# Password per caricare i giochi (la riga che inizia con uno spazio non resta nella cronologia)
 read -rsp "Password per caricare i giochi: " P && echo "GIOCHI_PASSWORD=$P" >> .env && unset P && echo
echo "GIOCHI_PUBLIC_URL=https://parole-esercizi.<tailnet>.ts.net/m" >> .env
docker compose up -d --build
curl -I http://127.0.0.1:8085
```

Aggiornamento automatico ogni 5 minuti (senza sudo):

```bash
(crontab -l 2>/dev/null; echo "*/5 * * * * cd $HOME/minigiochi && ./update.sh >> $HOME/minigiochi/update.log 2>&1") | crontab -
```

### Isolamento dalla rete di casa

Il servizio `giochi` riceve richieste da Internet, quindi i container stanno su una rete con bridge dal nome fisso (`br-minigiochi`) e le regole in `firewall/` bloccano ogni connessione nuova che ne esce verso LAN, tailnet, Internet e il Pi stesso. nginx e il servizio dei giochi possono comunque parlarsi. Installazione (una volta):

```bash
cd ~/minigiochi
sudo install -m 755 firewall/minigiochi-firewall.sh /usr/local/sbin/minigiochi-firewall.sh
sudo install -m 644 firewall/minigiochi-firewall.service /etc/systemd/system/minigiochi-firewall.service
sudo systemctl daemon-reload
sudo systemctl enable --now minigiochi-firewall.service
sudo minigiochi-firewall.sh status
```

Verifica (prima delle regole deve rispondere `RAGGIUNTO`, dopo `BLOCCATO`):

```bash
docker compose exec giochi wget -q -T 3 -O /dev/null http://192.168.1.1 && echo RAGGIUNTO || echo BLOCCATO
```

Backup dei giochi caricati e dei gruppi:

```bash
docker run --rm -v minigiochi_giochi-caricati:/data -v "$HOME":/backup alpine tar czf /backup/minigiochi-caricati.tgz -C /data .
docker run --rm -v minigiochi_giochi-stato:/data -v "$HOME":/backup alpine tar czf /backup/minigiochi-gruppi.tgz -C /data .
```

## Porte

| Uso | Porta |
|---|---|
| Pagina (LAN e tailnet, http) | 8085 |
| Link pubblici (solo sul Pi, esce dal funnel di Parole su `/m/`) | 127.0.0.1:8086 |
