package client

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestPrepareImagePreservesCompliantAndTransparency(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 64, 32))
	img.SetNRGBA(1, 1, color.NRGBA{R: 255, A: 128})
	var raw bytes.Buffer
	if err := png.Encode(&raw, img); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "透明.png")
	if err := os.WriteFile(path, raw.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	_, data, err := PrepareImage(context.Background(), path)
	if err != nil || !bytes.Equal(data, raw.Bytes()) {
		t.Fatalf("合规图片未保留：%v", err)
	}
	padded := append(raw.Bytes(), make([]byte, ImageFileLimit)...)
	_ = os.WriteFile(path, padded, 0600)
	_, data, err = PrepareImage(context.Background(), path)
	if err != nil || len(data) > ImageFileLimit {
		t.Fatalf("压缩失败：%v", err)
	}
	decoded, format, err := image.Decode(bytes.NewReader(data))
	if err != nil || format != "png" {
		t.Fatal("透明图格式丢失")
	}
	_, _, _, a := decoded.At(1, 1).RGBA()
	if a == 65535 {
		t.Fatal("透明度丢失")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err = PrepareImage(ctx, path); err == nil {
		t.Fatal("取消未生效")
	}
}
func TestPrepareImageCorrectsEXIFAndDimensions(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 40, 20))
	var raw bytes.Buffer
	_ = jpeg.Encode(&raw, img, nil)
	// TIFF little-endian IFD0: orientation=6（顺时针 90°）。
	exif := []byte{'E', 'x', 'i', 'f', 0, 0, 'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0}
	payload := []byte{0xff, 0xd8, 0xff, 0xe1, 0, byte(len(exif) + 2)}
	payload = append(payload, exif...)
	payload = append(payload, raw.Bytes()[2:]...)
	path := filepath.Join(t.TempDir(), "rotated.jpg")
	_ = os.WriteFile(path, payload, 0600)
	_, data, err := PrepareImage(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width != 20 || cfg.Height != 40 {
		t.Fatalf("方向校正失败：%+v %v", cfg, err)
	}
	raw.Reset()
	_ = png.Encode(&raw, image.NewGray(image.Rect(0, 0, 6001, 2)))
	_ = os.WriteFile(path, raw.Bytes(), 0600)
	_, data, err = PrepareImage(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	cfg, _, _ = image.DecodeConfig(bytes.NewReader(data))
	if cfg.Width > 6000 || cfg.Height > 6000 {
		t.Fatal("最长边未限制")
	}
}
