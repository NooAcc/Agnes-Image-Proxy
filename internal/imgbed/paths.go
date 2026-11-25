package imgbed

import (
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

const uploadRoot = "agnes-image-proxy"

// chinaZone is fixed at UTC+8 and never consults the system time zone or
// tzdata, so distroless images keep the same calendar date.
var chinaZone = time.FixedZone("China Standard Time", 8*60*60)

func uploadFolder(at time.Time) string {
	return uploadRoot + "/" + at.In(chinaZone).Format("2006-01-02")
}

// ValidRef accepts exactly a decoded relative file ID:
// agnes-image-proxy/YYYY-MM-DD/<single safe file name>.
func ValidRef(ref string) bool {
	parts := strings.Split(ref, "/")
	if len(parts) != 3 || parts[0] != uploadRoot {
		return false
	}
	if !validCalendarDate(parts[1]) {
		return false
	}
	return validFileName(parts[2])
}

func validCalendarDate(value string) bool {
	parsed, err := time.Parse("2006-01-02", value)
	return err == nil && parsed.Format("2006-01-02") == value
}

func validFileName(name string) bool {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\") || strings.Contains(name, "..") {
		return false
	}
	lower := strings.ToLower(name)
	if strings.Contains(lower, "%2f") || strings.Contains(lower, "%5c") {
		return false
	}
	for i := 0; i < len(name); i++ {
		if name[i] < 0x20 || name[i] == 0x7f {
			return false
		}
	}
	return true
}

// parseUploadSource validates the upload response source and returns its
// decoded relative file ID. When folder is non-empty the file must live in
// exactly that folder.
func parseUploadSource(src, baseURL, folder string) (string, error) {
	parsed, err := url.Parse(src)
	if err != nil || parsed.Hostname() == "" || parsed.User != nil {
		return "", errors.New("invalid upload source")
	}
	if parsed.Scheme != "https" || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return "", errors.New("invalid upload source")
	}
	origin, err := normalizeOrigin(parsed)
	if err != nil || origin != baseURL {
		return "", errors.New("upload source is not on the configured origin")
	}
	escaped := parsed.EscapedPath()
	const prefix = "/file/"
	if !strings.HasPrefix(escaped, prefix) {
		return "", errors.New("upload source is not a file path")
	}
	rest := strings.TrimPrefix(escaped, prefix)
	segments := strings.Split(rest, "/")
	decoded := make([]string, 0, len(segments))
	for _, segment := range segments {
		value, err := url.PathUnescape(segment)
		if err != nil || value == "" || value == "." || value == ".." ||
			strings.ContainsAny(value, "/\\") || hasControlCharacter(value) {
			return "", errors.New("upload source path is unsafe")
		}
		decoded = append(decoded, value)
	}
	ref := strings.Join(decoded, "/")
	if !ValidRef(ref) {
		return "", errors.New("upload source reference is invalid")
	}
	if folder != "" && !strings.HasPrefix(ref, folder+"/") {
		return "", errors.New("upload source is outside the upload folder")
	}
	return ref, nil
}

// PublicFileURL builds a token-free URL for a stored original on the current site.
func PublicFileURL(baseURL, ref string) (string, error) {
	origin, err := domain.NormalizeImgbedBaseURL(baseURL)
	if err != nil {
		return "", err
	}
	return fileURL(origin, "file", ref)
}

// fileURL rebuilds a file or delete endpoint for the current site address,
// escaping each decoded segment exactly once. It never cleans a path.
func fileURL(baseURL, endpoint, ref string) (string, error) {
	if !ValidRef(ref) {
		return "", errors.New("invalid imgbed reference")
	}
	segments := strings.Split(ref, "/")
	escaped := make([]string, len(segments))
	for i, segment := range segments {
		escaped[i] = url.PathEscape(segment)
	}
	return baseURL + "/" + endpoint + "/" + strings.Join(escaped, "/"), nil
}

func hasControlCharacter(value string) bool {
	for i := 0; i < len(value); i++ {
		if value[i] < 0x20 || value[i] == 0x7f {
			return true
		}
	}
	return false
}

func normalizeOrigin(parsed *url.URL) (string, error) {
	return domain.NormalizeImgbedBaseURL(parsed.Scheme + "://" + parsed.Host)
}
