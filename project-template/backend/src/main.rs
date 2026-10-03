//! Backend entry point. Replace with your application.

fn greeting() -> &'static str {
    "hello from the backend"
}

fn main() {
    println!("{}", greeting());
}

#[cfg(test)]
mod tests {
    use super::greeting;

    #[test]
    fn greets() {
        assert!(greeting().contains("backend"));
    }
}
