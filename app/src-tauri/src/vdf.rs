pub(crate) fn split_quoted_pair(line: &str) -> Option<(String, String)> {
    let mut fields = Vec::new();
    let mut chars = line.chars().peekable();
    while chars.peek().is_some() {
        while chars.peek().map_or(false, |c| c.is_whitespace()) {
            chars.next();
        }
        if chars.peek() != Some(&'"') {
            break;
        }
        chars.next();
        let mut field = String::new();
        for c in chars.by_ref() {
            if c == '"' {
                break;
            }
            field.push(c);
        }
        fields.push(field);
        if fields.len() == 2 {
            break;
        }
    }
    if fields.len() == 2 {
        Some((fields[0].clone(), fields[1].clone()))
    } else {
        None
    }
}

pub fn library_paths(libraryfolders_vdf: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in libraryfolders_vdf.lines() {
        let line = line.trim();
        if line.starts_with("\"path\"") {
            if let Some((_, value)) = split_quoted_pair(line) {
                paths.push(value.replace("\\\\", "\\"));
            }
        }
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_library_paths() {
        let sample = r#"
"libraryfolders"
{
    "0"
    {
        "path"    "C:\\Program Files (x86)\\Steam"
        "label"    ""
    }
    "1"
    {
        "path"    "D:\\SteamLibrary"
    }
}
"#;
        assert_eq!(
            library_paths(sample),
            vec!["C:\\Program Files (x86)\\Steam", "D:\\SteamLibrary"]
        );
    }
}
