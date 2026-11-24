package images

import (
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

// SizeTiers are the native Agnes tiers.
var SizeTiers = []string{"1K", "2K", "3K", "4K"}

// Ratios are the native Agnes aspect ratios in table order. Ties resolve to
// the earlier entry.
var Ratios = []string{"1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"}

var baseSizes = map[string]domain.PixelSize{
	"1:1":  {Width: 1024, Height: 1024},
	"3:4":  {Width: 864, Height: 1152},
	"4:3":  {Width: 1152, Height: 864},
	"16:9": {Width: 1312, Height: 736},
	"9:16": {Width: 736, Height: 1312},
	"2:3":  {Width: 832, Height: 1248},
	"3:2":  {Width: 1248, Height: 832},
	"21:9": {Width: 1568, Height: 672},
}

var tierScale = map[string]int{"1K": 1, "2K": 2, "3K": 3, "4K": 4}

var tierArea = map[string]float64{
	"1K": 1024 * 1024,
	"2K": 2048 * 2048,
	"3K": 3072 * 3072,
	"4K": 4096 * 4096,
}

var pixelPattern = regexp.MustCompile(`(?i)^(\d{1,6})\s*[x×]\s*(\d{1,6})$`)

// IsSizeTier reports whether value is one of 1K..4K (case-insensitive).
func IsSizeTier(value string) bool {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "1K", "2K", "3K", "4K":
		return true
	}
	return false
}

func isRatio(value string) bool {
	_, ok := baseSizes[value]
	return ok
}

func ratioValue(ratio string) float64 {
	parts := strings.SplitN(ratio, ":", 2)
	width, _ := strconv.Atoi(parts[0])
	height, _ := strconv.Atoi(parts[1])
	return float64(width) / float64(height)
}

func nearestRatio(aspect float64) string {
	best := Ratios[0]
	bestDistance := math.Inf(1)
	for _, ratio := range Ratios {
		distance := math.Abs(math.Log(aspect / ratioValue(ratio)))
		if distance < bestDistance {
			best = ratio
			bestDistance = distance
		}
	}
	return best
}

func nearestTier(area float64) string {
	best := SizeTiers[0]
	bestDistance := math.Inf(1)
	for _, tier := range SizeTiers {
		distance := math.Abs(math.Log(area / tierArea[tier]))
		if distance < bestDistance {
			best = tier
			bestDistance = distance
		}
	}
	return best
}

func scaledPixel(ratio, tier string) domain.PixelSize {
	base := baseSizes[ratio]
	scale := tierScale[tier]
	return domain.PixelSize{Width: base.Width * scale, Height: base.Height * scale}
}

func parsePixelSize(value string) (domain.PixelSize, bool) {
	match := pixelPattern.FindStringSubmatch(strings.TrimSpace(value))
	if match == nil {
		return domain.PixelSize{}, false
	}
	width, _ := strconv.Atoi(match[1])
	height, _ := strconv.Atoi(match[2])
	if width < 1 || height < 1 {
		return domain.PixelSize{}, false
	}
	return domain.PixelSize{Width: width, Height: height}, true
}

// ResolveSize translates a client size (tier, WxH, empty/auto) plus an
// optional ratio into the upstream tier/ratio pair and expected pixels. When
// auto is paired with a reference image, an exact size is returned.
func ResolveSize(size, ratio string, reference *domain.PixelSize, defaultTier string) (domain.ResolvedSize, error) {
	rawSize := strings.TrimSpace(size)
	rawRatio := strings.TrimSpace(ratio)

	var explicitRatio *string
	if rawRatio != "" {
		if !isRatio(rawRatio) {
			return domain.ResolvedSize{}, apierror.Invalid("ratio", "unsupported ratio: "+rawRatio, "invalid_ratio")
		}
		value := rawRatio
		explicitRatio = &value
	}

	defaultTier = strings.ToUpper(strings.TrimSpace(defaultTier))
	if !IsSizeTier(defaultTier) {
		defaultTier = "1K"
	}

	isAuto := rawSize == "" || strings.EqualFold(rawSize, "auto")

	if isAuto && reference != nil && reference.Width > 0 && reference.Height > 0 {
		tier := nearestTier(float64(reference.Width) * float64(reference.Height))
		derived := nearestRatio(float64(reference.Width) / float64(reference.Height))
		exact := domain.PixelSize{Width: reference.Width, Height: reference.Height}
		return domain.ResolvedSize{
			Mode:         "exact",
			Tier:         tier,
			Ratio:        explicitRatio,
			DerivedRatio: derived,
			Expected:     scaledPixel(derived, tier),
			Exact:        &exact,
		}, nil
	}

	tier := defaultTier
	inferred := "1:1"
	selected := explicitRatio

	switch {
	case isAuto:
		tier = defaultTier
	case IsSizeTier(rawSize):
		tier = strings.ToUpper(rawSize)
	default:
		pixel, ok := parsePixelSize(rawSize)
		if !ok {
			return domain.ResolvedSize{}, apierror.Invalid("size", "unsupported size: "+rawSize, "invalid_size")
		}
		tier = nearestTier(float64(pixel.Width) * float64(pixel.Height))
		inferred = nearestRatio(float64(pixel.Width) / float64(pixel.Height))
		if selected == nil {
			value := inferred
			selected = &value
		}
	}

	ratioName := "1:1"
	if selected != nil {
		ratioName = *selected
	}
	return domain.ResolvedSize{
		Mode:         "tier",
		Tier:         tier,
		Ratio:        selected,
		DerivedRatio: ratioName,
		Expected:     scaledPixel(ratioName, tier),
	}, nil
}

// FormatPixel renders a pixel size as WxH.
func FormatPixel(size domain.PixelSize) string {
	return strconv.Itoa(size.Width) + "x" + strconv.Itoa(size.Height)
}

// FormatRequestSize renders the requested size for headers and logs.
func FormatRequestSize(size domain.ResolvedSize) string {
	if size.Mode == "exact" && size.Exact != nil {
		return FormatPixel(*size.Exact)
	}
	if size.Ratio != nil {
		return size.Tier + " " + *size.Ratio
	}
	return size.Tier
}
