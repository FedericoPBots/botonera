package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"time"
)

type Config struct {
	Clave         string    `json:"clave"`
	Silenciado    bool      `json:"silenciado"`
	SilencioHasta time.Time `json:"silencioHasta"`
	SoloConSlack  bool      `json:"soloConSlack"`
	ArrancarConPC bool      `json:"arrancarConPC"`

	primeraVez bool
}

func carpetaConfig() string {
	base, err := os.UserConfigDir()
	if err != nil {
		base = os.TempDir()
	}
	dir := filepath.Join(base, "Botonera")
	os.MkdirAll(dir, 0o700)
	return dir
}

func carpetaSonidos() string {
	base, err := os.UserCacheDir()
	if err != nil {
		base = os.TempDir()
	}
	dir := filepath.Join(base, "Botonera", "sonidos")
	os.MkdirAll(dir, 0o700)
	return dir
}

func leerConfig() Config {
	var cfg Config
	datos, err := os.ReadFile(filepath.Join(carpetaConfig(), "config.json"))
	if err != nil {
		cfg.primeraVez = true
		return cfg
	}
	if err := json.Unmarshal(datos, &cfg); err != nil {
		log.Printf("config ilegible, empiezo de cero: %v", err)
		cfg = Config{primeraVez: true}
	}
	return cfg
}

func guardarConfig(cfg Config) {
	datos, _ := json.MarshalIndent(cfg, "", "  ")
	if err := os.WriteFile(filepath.Join(carpetaConfig(), "config.json"), datos, 0o600); err != nil {
		log.Printf("no pude guardar la config: %v", err)
	}
}

func (c Config) silenciadoAhora() bool {
	return c.Silenciado || time.Now().Before(c.SilencioHasta)
}
