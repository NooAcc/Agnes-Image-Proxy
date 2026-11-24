package httpapi

// ImageResponse is the OpenAI-compatible image delivery envelope.
type ImageResponse struct {
	Created int64               `json:"created"`
	Data    []ImageResponseItem `json:"data"`
	Size    string              `json:"size"`
}
type ImageResponseItem struct {
	URL           *string `json:"url,omitempty"`
	B64JSON       *string `json:"b64_json,omitempty"`
	RevisedPrompt *string `json:"revised_prompt"`
}
