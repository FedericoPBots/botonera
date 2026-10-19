package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"runtime"
)

// Un parlante violeta dibujado al vuelo: así no hay archivos de ícono por sistema.
func icono() []byte {
	const lado = 32
	img := image.NewNRGBA(image.Rect(0, 0, lado, lado))
	violeta := color.NRGBA{0xA7, 0x8B, 0xFA, 0xFF}
	for y := 0; y < lado; y++ {
		for x := 0; x < lado; x++ {
			// Cuerpo del parlante y la bocina en forma de trapecio.
			cuerpo := x >= 5 && x <= 11 && y >= 12 && y <= 20
			bocina := x > 11 && x <= 19 && y >= 12-(x-11) && y <= 20+(x-11)
			// Dos ondas: anillos alrededor del centro de la bocina.
			dx, dy := float64(x-19), float64(y-16)
			r2 := dx*dx + dy*dy
			onda := x > 21 && ((r2 >= 20 && r2 <= 32) || (r2 >= 64 && r2 <= 82))
			if cuerpo || bocina || onda {
				img.Set(x, y, violeta)
			}
		}
	}
	var datos bytes.Buffer
	png.Encode(&datos, img)
	if runtime.GOOS != "windows" {
		return datos.Bytes()
	}

	// Windows pide .ico: un encabezado y el PNG adentro (válido desde Vista).
	var ico bytes.Buffer
	binary.Write(&ico, binary.LittleEndian, []uint16{0, 1, 1})
	ico.Write([]byte{lado, lado, 0, 0})
	binary.Write(&ico, binary.LittleEndian, []uint16{1, 32})
	binary.Write(&ico, binary.LittleEndian, []uint32{uint32(datos.Len()), 22})
	ico.Write(datos.Bytes())
	return ico.Bytes()
}
