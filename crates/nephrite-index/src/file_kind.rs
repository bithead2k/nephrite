#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Markdown,
    Canvas,
    Image,
    Excalidraw,
    Attachment,
    Other,
}

impl FileKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Markdown => "markdown",
            Self::Canvas => "canvas",
            Self::Image => "image",
            Self::Excalidraw => "excalidraw",
            Self::Attachment => "attachment",
            Self::Other => "other",
        }
    }

    pub fn from_extension(ext: &str) -> Self {
        let e = ext.to_ascii_lowercase();
        match e.as_str() {
            "md" | "markdown" => Self::Markdown,
            "canvas" => Self::Canvas,
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" => Self::Image,
            "excalidraw" => Self::Excalidraw,
            "pdf" => Self::Attachment,
            "mp3" | "mp4" | "webm" | "wav" | "ogg" | "zip" => Self::Attachment,
            _ => Self::Other,
        }
    }
}
