package client

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/disintegration/imaging"
)

// PrepareImage 与 Web 共用边界：保留合规原字节，校正方向，透明图片保留 PNG。
func PrepareImage(ctx context.Context, path string) (string, []byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", nil, err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return "", nil, err
	}
	if !stat.Mode().IsRegular() || stat.Size() > 64<<20 {
		return "", nil, fmt.Errorf("请选择不超过 64 MiB 的普通 JPEG/PNG 文件")
	}
	raw, err := io.ReadAll(io.LimitReader(f, 64<<20+1))
	if err != nil {
		return "", nil, err
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || (format != "jpeg" && format != "png") {
		return "", nil, fmt.Errorf("仅支持 JPEG 和 PNG 图片")
	}
	if config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > 80_000_000 {
		return "", nil, fmt.Errorf("图片解码像素超过 8000 万限制")
	}
	if err = ctx.Err(); err != nil {
		return "", nil, err
	}
	original, err := imaging.Decode(bytes.NewReader(raw), imaging.AutoOrientation(true))
	if err != nil {
		return "", nil, err
	}
	// 方向不为 1 的 JPEG 必须重编码，尺寸一致也可能是镜像或旋转 180°。
	oriented := format == "jpeg" && jpegOrientation(raw) > 1
	name := filepath.Base(path)
	if len(raw) <= ImageFileLimit && config.Width <= 6000 && config.Height <= 6000 && !oriented {
		return name, raw, ctx.Err()
	}
	if original.Bounds().Dx() > 6000 || original.Bounds().Dy() > 6000 {
		original = imaging.Fit(original, 6000, 6000, imaging.Lanczos)
	}
	transparent := false
	if format == "png" {
		if opaque, ok := original.(interface{ Opaque() bool }); ok {
			transparent = !opaque.Opaque()
		} else {
			transparent = true
		}
	}
	for {
		if err = ctx.Err(); err != nil {
			return "", nil, err
		}
		var result bytes.Buffer
		if transparent {
			err = png.Encode(&result, original)
		} else {
			for quality := 95; quality >= 80; quality-- {
				result.Reset()
				err = jpeg.Encode(&result, original, &jpeg.Options{Quality: quality})
				if err != nil || result.Len() <= ImageFileLimit {
					break
				}
				if err = ctx.Err(); err != nil {
					return "", nil, err
				}
			}
		}
		if err != nil {
			return "", nil, err
		}
		if result.Len() <= ImageFileLimit {
			ext := ".jpg"
			if transparent {
				ext = ".png"
			}
			return strings.TrimSuffix(name, filepath.Ext(name)) + ext, result.Bytes(), nil
		}
		w, h := original.Bounds().Dx()*85/100, original.Bounds().Dy()*85/100
		if w < 1 || h < 1 {
			return "", nil, fmt.Errorf("图片无法压缩至 1 MiB")
		}
		original = imaging.Resize(original, w, h, imaging.Lanczos)
	}
}

// JPEG 的 APP1 TIFF 方向读取仅用于判断原字节能否保留；实际转换交给 imaging。
func jpegOrientation(raw []byte) int {
	for i := 2; i+4 <= len(raw); {
		if raw[i] != 0xff {
			return 1
		}
		marker := raw[i+1]
		if marker == 0xda || marker == 0xd9 {
			return 1
		}
		size := int(raw[i+2])<<8 | int(raw[i+3])
		if size < 2 || i+2+size > len(raw) {
			return 1
		}
		data := raw[i+4 : i+2+size]
		i += 2 + size
		if marker != 0xe1 || len(data) < 14 || string(data[:6]) != "Exif\x00\x00" {
			continue
		}
		data = data[6:]
		little := string(data[:2]) == "II"
		u16 := func(p int) int {
			if little {
				return int(data[p]) | int(data[p+1])<<8
			}
			return int(data[p])<<8 | int(data[p+1])
		}
		u32 := func(p int) uint64 {
			if little {
				return uint64(data[p]) | uint64(data[p+1])<<8 | uint64(data[p+2])<<16 | uint64(data[p+3])<<24
			}
			return uint64(data[p])<<24 | uint64(data[p+1])<<16 | uint64(data[p+2])<<8 | uint64(data[p+3])
		}
		offset := u32(4)
		if offset+2 > uint64(len(data)) {
			return 1
		}
		n := u16(int(offset))
		for j := 0; j < n; j++ {
			p := int(offset) + 2 + j*12
			if p+12 > len(data) {
				break
			}
			if u16(p) == 0x112 && u16(p+2) == 3 && u32(p+4) == 1 {
				return u16(p + 8)
			}
		}
	}
	return 1
}
