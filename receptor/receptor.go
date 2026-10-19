package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type aviso struct {
	Type string `json:"type"`
	Key  string `json:"key"`
	Name string `json:"name"`
	At   int64  `json:"at"`
}

type Receptor struct {
	mu         sync.Mutex
	cfg        Config
	reconectar chan struct{}
	estado     func(string)
	cola       chan aviso
}

func nuevoReceptor(cfg Config, estado func(string)) *Receptor {
	return &Receptor{cfg: cfg, reconectar: make(chan struct{}, 1), estado: estado, cola: make(chan aviso, 5)}
}

func (r *Receptor) config() Config {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.cfg
}

// Cambia la config y la guarda; reconecta si cambió algo de la conexión (la clave, lo de Slack).
func (r *Receptor) cambiar(cambio func(*Config), reconectar bool) {
	r.mu.Lock()
	cambio(&r.cfg)
	guardarConfig(r.cfg)
	r.mu.Unlock()
	if !reconectar {
		return
	}
	select {
	case r.reconectar <- struct{}{}:
	default:
	}
}

func (r *Receptor) correr() {
	go r.reproducirCola()
	espera := time.Second
	for {
		cfg := r.config()
		switch {
		case cfg.Clave == "":
			r.estado("Falta la clave: pedila con /sonido receptor")
			<-r.reconectar
			continue
		case cfg.SoloConSlack && !slackAbierto():
			r.estado("En pausa: Slack está cerrado")
			r.esperar(10 * time.Second)
			continue
		}

		err := r.escuchar(cfg)
		var rechazo errorDeAcceso
		switch {
		case errors.As(err, &rechazo):
			r.estado(rechazo.Error())
			<-r.reconectar
			espera = time.Second
			continue
		case errors.Is(err, errReconectar), errors.Is(err, errSlackCerrado):
			espera = time.Second
			continue
		case err != nil:
			log.Printf("conexión: %v", err)
			r.estado("Sin conexión, reintentando…")
		}
		r.esperar(espera)
		espera = min(espera*2, time.Minute)
	}
}

func (r *Receptor) esperar(tiempo time.Duration) {
	select {
	case <-time.After(tiempo):
	case <-r.reconectar:
	}
}

type errorDeAcceso string

func (e errorDeAcceso) Error() string { return string(e) }

var (
	errReconectar   = errors.New("reconectar")
	errSlackCerrado = errors.New("slack cerrado")
)

func (r *Receptor) escuchar(cfg Config) error {
	ctx, cancelar := context.WithCancel(context.Background())
	defer cancelar()

	conn, resp, err := websocket.Dial(ctx, "wss://"+servidor+"/receptor/conectar", &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + cfg.Clave}},
	})
	if resp != nil && resp.StatusCode == http.StatusUnauthorized {
		return errorDeAcceso("La clave no sirve: pedí una nueva con /sonido receptor")
	}
	if resp != nil && resp.StatusCode == http.StatusForbidden {
		return errorDeAcceso("Sin acceso: tenés que estar en el canal de la Botonera")
	}
	if err != nil {
		return err
	}
	defer conn.CloseNow()
	r.estado("Conectado")

	// Mantiene viva la conexión y la corta si cambia la config o se cierra Slack.
	salida := make(chan error, 1)
	go func() {
		ping := time.NewTicker(30 * time.Second)
		defer ping.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-r.reconectar:
				salida <- errReconectar
				cancelar()
				return
			case <-ping.C:
				if cfg.SoloConSlack && !slackAbierto() {
					salida <- errSlackCerrado
					cancelar()
					return
				}
				conn.Write(ctx, websocket.MessageText, []byte("ping"))
			}
		}
	}()

	for {
		_, datos, err := conn.Read(ctx)
		if err != nil {
			select {
			case motivo := <-salida:
				return motivo
			default:
			}
			if websocket.CloseStatus(err) == 4003 {
				return errorDeAcceso("Sin acceso: tenés que estar en el canal de la Botonera")
			}
			return err
		}
		if string(datos) == "pong" {
			continue
		}
		var msg aviso
		if json.Unmarshal(datos, &msg) != nil || msg.Type != "sonido" {
			continue
		}
		select {
		case r.cola <- msg:
		default:
			log.Printf("cola llena, salteo %s", msg.Name)
		}
	}
}

// De a un sonido por vez, para que no se pisen.
func (r *Receptor) reproducirCola() {
	for msg := range r.cola {
		if r.config().silenciadoAhora() {
			continue
		}
		archivo, err := r.bajar(msg)
		if err != nil {
			log.Printf("bajar %s: %v", msg.Name, err)
			continue
		}
		if err := reproducir(archivo); err != nil {
			log.Printf("reproducir %s: %v", msg.Name, err)
		}
	}
}

// Guarda cada sonido una vez; si lo reemplazan cambia "at" y se baja de nuevo.
func (r *Receptor) bajar(msg aviso) (string, error) {
	slug := strings.TrimPrefix(msg.Key, "sound:")
	if existentes, _ := filepath.Glob(filepath.Join(carpetaSonidos(), fmt.Sprintf("%s-%d.*", slug, msg.At))); len(existentes) > 0 {
		return existentes[0], nil
	}

	pedido, _ := http.NewRequest(http.MethodGet, "https://"+servidor+"/receptor/audio/"+slug, nil)
	pedido.Header.Set("Authorization", "Bearer "+r.config().Clave)
	cliente := http.Client{Timeout: 30 * time.Second}
	resp, err := cliente.Do(pedido)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("el servidor respondió %d", resp.StatusCode)
	}

	archivo := filepath.Join(carpetaSonidos(), fmt.Sprintf("%s-%d%s", slug, msg.At, extension(resp.Header.Get("Content-Type"))))
	temporal := archivo + ".parcial"
	destino, err := os.Create(temporal)
	if err != nil {
		return "", err
	}
	_, err = io.Copy(destino, io.LimitReader(resp.Body, 5<<20))
	destino.Close()
	if err != nil {
		os.Remove(temporal)
		return "", err
	}
	return archivo, os.Rename(temporal, archivo)
}

func extension(tipo string) string {
	switch {
	case strings.Contains(tipo, "wav"):
		return ".wav"
	case strings.Contains(tipo, "ogg"):
		return ".ogg"
	case strings.Contains(tipo, "mp4"), strings.Contains(tipo, "m4a"), strings.Contains(tipo, "aac"):
		return ".m4a"
	case strings.Contains(tipo, "flac"):
		return ".flac"
	default:
		return ".mp3"
	}
}
