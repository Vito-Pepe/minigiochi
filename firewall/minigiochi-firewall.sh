#!/usr/bin/env bash
# Isola i container di minigiochi (nginx e servizio giochi): blocca ogni connessione NUOVA
# che esce dal loro bridge (br-minigiochi) verso LAN, tailnet, Internet e verso il Pi stesso.
# Restano permesse le connessioni tra i due container (nginx -> giochi) e le risposte alle
# richieste in arrivo sulle porte 8085 e 8086, quindi pagina e link dei giochi funzionano.
#
# Uso: sudo minigiochi-firewall.sh [apply|remove|status]

set -euo pipefail

BRIDGE=br-minigiochi
ACTION=${1:-apply}

# DOCKER-USER: traffico instradato. "! -o" lascia passare il traffico interno al bridge.
FWD_DROP=(-i "$BRIDGE" ! -o "$BRIDGE" -m conntrack --ctstate NEW -j DROP)
FWD_LOG=(-i "$BRIDGE" ! -o "$BRIDGE" -m conntrack --ctstate NEW -m limit --limit 6/min -j LOG --log-prefix "minigiochi-bloccato: ")
# INPUT: traffico diretto al Pi stesso (SSH, altre app, Tailscale del Pi).
IN_DROP=(-i "$BRIDGE" -m conntrack --ctstate NEW -j DROP)
IN_LOG=(-i "$BRIDGE" -m conntrack --ctstate NEW -m limit --limit 6/min -j LOG --log-prefix "minigiochi-bloccato: ")

if [ "$(id -u)" -ne 0 ]; then
    echo "Va eseguito con sudo." >&2
    exit 1
fi
if ! command -v iptables >/dev/null; then
    echo "iptables non trovato." >&2
    exit 1
fi
if ! iptables -n -L DOCKER-USER >/dev/null 2>&1; then
    echo "Catena DOCKER-USER assente: Docker non è avviato o non usa iptables." >&2
    exit 1
fi

add_rule() {
    local chain=$1; shift
    iptables -C "$chain" "$@" 2>/dev/null || iptables -I "$chain" "$@"
}

del_rule() {
    local chain=$1; shift
    while iptables -C "$chain" "$@" 2>/dev/null; do
        iptables -D "$chain" "$@"
    done
}

case "$ACTION" in
    apply)
        # Prima il DROP, poi il LOG inserito sopra: ogni blocco viene prima registrato.
        add_rule DOCKER-USER "${FWD_DROP[@]}"
        add_rule DOCKER-USER "${FWD_LOG[@]}"
        add_rule INPUT "${IN_DROP[@]}"
        add_rule INPUT "${IN_LOG[@]}"
        echo "Regole di isolamento di minigiochi attive."
        ;;
    remove)
        del_rule DOCKER-USER "${FWD_LOG[@]}"
        del_rule DOCKER-USER "${FWD_DROP[@]}"
        del_rule INPUT "${IN_LOG[@]}"
        del_rule INPUT "${IN_DROP[@]}"
        echo "Regole di isolamento di minigiochi rimosse."
        ;;
    status)
        for chain in DOCKER-USER INPUT; do
            echo "== $chain"
            iptables -L "$chain" -v -n | grep -E "^ *[0-9].*$BRIDGE" || echo "   (nessuna regola per $BRIDGE)"
        done
        ;;
    *)
        echo "Uso: $0 [apply|remove|status]" >&2
        exit 2
        ;;
esac
