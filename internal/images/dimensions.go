package images

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

var pngSignature = []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}

var dataURIPattern = regexp.MustCompile(`(?i)^data:image/(png|jpeg|jpg|webp);base64,`)

// SniffImage reports the supported image MIME type of the bytes, or "".
func SniffImage(data []byte) string {
	switch http.DetectContentType(data) {
	case "image/png":
		return "image/png"
	case "image/jpeg":
		return "image/jpeg"
	case "image/webp":
		return "image/webp"
	}
	return ""
}

// ImageDimensions parses image dimensions from PNG, JPEG or WebP bytes without
// decoding the full image.
func ImageDimensions(data []byte) (domain.PixelSize, error) {
	switch SniffImage(data) {
	case "image/png":
		return pngDimensions(data)
	case "image/jpeg":
		return jpegDimensions(data)
	case "image/webp":
		return webpDimensions(data)
	}
	return domain.PixelSize{}, errors.New("unsupported image format")
}

func pngDimensions(data []byte) (domain.PixelSize, error) {
	if len(data) < 24 || !bytes.Equal(data[:8], pngSignature) || string(data[12:16]) != "IHDR" {
		return domain.PixelSize{}, errors.New("invalid png header")
	}
	width := int(binary.BigEndian.Uint32(data[16:20]))
	height := int(binary.BigEndian.Uint32(data[20:24]))
	if width < 1 || height < 1 {
		return domain.PixelSize{}, errors.New("invalid png dimensions")
	}
	return domain.PixelSize{Width: width, Height: height}, nil
}

func jpegDimensions(data []byte) (domain.PixelSize, error) {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return domain.PixelSize{}, errors.New("invalid jpeg header")
	}
	for i := 2; i+9 <= len(data); {
		if data[i] != 0xFF {
			i++
			continue
		}
		marker := data[i+1]
		if marker == 0xD8 || marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7) {
			i += 2
			continue
		}
		if marker == 0xD9 || marker == 0xDA {
			break
		}
		if i+4 > len(data) {
			break
		}
		length := int(binary.BigEndian.Uint16(data[i+2 : i+4]))
		if length < 2 {
			break
		}
		if isSOF(marker) {
			if i+9 > len(data) {
				break
			}
			height := int(binary.BigEndian.Uint16(data[i+5 : i+7]))
			width := int(binary.BigEndian.Uint16(data[i+7 : i+9]))
			if width < 1 || height < 1 {
				return domain.PixelSize{}, errors.New("invalid jpeg dimensions")
			}
			return domain.PixelSize{Width: width, Height: height}, nil
		}
		i += 2 + length
	}
	return domain.PixelSize{}, errors.New("jpeg dimensions not found")
}

func isSOF(marker byte) bool {
	switch marker {
	case 0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF:
		return true
	}
	return false
}

func webpDimensions(data []byte) (domain.PixelSize, error) {
	if len(data) < 30 || string(data[0:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return domain.PixelSize{}, errors.New("invalid webp header")
	}
	for i := 12; i+8 <= len(data); {
		fourCC := string(data[i : i+4])
		size := int(binary.LittleEndian.Uint32(data[i+4 : i+8]))
		payload := data[i+8:]
		switch fourCC {
		case "VP8X":
			if len(payload) >= 10 {
				return domain.PixelSize{Width: readUint24LE(payload[4:7]) + 1, Height: readUint24LE(payload[7:10]) + 1}, nil
			}
		case "VP8L":
			if len(payload) >= 5 {
				bits := binary.LittleEndian.Uint32(payload[1:5])
				return domain.PixelSize{Width: int(bits&0x3FFF) + 1, Height: int((bits>>14)&0x3FFF) + 1}, nil
			}
		case "VP8 ":
			if len(payload) >= 10 {
				width := int(binary.LittleEndian.Uint16(payload[6:8]) & 0x3FFF)
				height := int(binary.LittleEndian.Uint16(payload[8:10]) & 0x3FFF)
				if width > 0 && height > 0 {
					return domain.PixelSize{Width: width, Height: height}, nil
				}
			}
		}
		step := 8 + size
		if size%2 == 1 {
			step++
		}
		i += step
	}
	return domain.PixelSize{}, errors.New("webp dimensions not found")
}

func readUint24LE(data []byte) int {
	return int(data[0]) | int(data[1])<<8 | int(data[2])<<16
}

// DecodeImageDataURI performs one bounded decode and validates the declared type.
func DecodeImageDataURI(value string, maxBytes int) (string, []byte, error) {
	match := dataURIPattern.FindStringSubmatch(value)
	if match == nil {
		return "", nil, fmt.Errorf("unsupported data URI")
	}
	payload := value[len(match[0]):]
	if payload == "" || len(payload)%4 != 0 || strings.ContainsAny(payload, "\r\n") {
		return "", nil, fmt.Errorf("invalid base64 image")
	}
	if len(payload) > base64.StdEncoding.EncodedLen(maxBytes) {
		return "", nil, fmt.Errorf("input image is too large")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(payload)
	if err != nil || len(data) == 0 || len(data) > maxBytes {
		return "", nil, fmt.Errorf("invalid or oversized base64 image")
	}
	mime := normalizeImageMIME("image/" + match[1])
	if SniffImage(data) != mime {
		return "", nil, fmt.Errorf("declared image type does not match image contents")
	}
	return mime, data, nil
}
func parseDataURI(value string) (mime string, payload string, byteLength int, ok bool) {
	mime, data, err := DecodeImageDataURI(value, MaxInputImageBytes)
	if err != nil {
		return "", "", 0, false
	}
	return mime, base64.StdEncoding.EncodeToString(data), len(data), true
}
func decodeDataURI(value string) (string, []byte, error) {
	return DecodeImageDataURI(value, MaxInputImageBytes)
}

func normalizeImageMIME(value string) string {
	value = strings.ToLower(strings.TrimSpace(strings.SplitN(value, ";", 2)[0]))
	if value == "image/jpg" {
		return "image/jpeg"
	}
	return value
}
