# Preserve Python story identities in a World-owned cast

Python productions contain independent current characters and relationships, while an ST runtime card is only an execution resource. Store the cast and player snapshot in the World manifest, project it into activation/context/editing and use those same entity IDs for the story ledger. Do not merge all characters into a library card or run separate generations per character; existing Worlds without a cast keep their current ST behavior.

The offline migration imports the latest persisted snapshot. It does not silently reintroduce Python's additional background character-update model calls. MVU remains separate, and newer narrative events take precedence over the imported snapshot.
