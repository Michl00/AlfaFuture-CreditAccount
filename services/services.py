def valid_inn(inn: str) -> bool:
    if not (inn.isascii() and inn.isdigit() and len(inn) in (10, 12)):
        return False
    def ctrl(digits, coefs):
        return sum(int(d) * c for d, c in zip(digits, coefs)) % 11 % 10
    if len(inn) == 10:
        return ctrl(inn, [2, 4, 10, 3, 5, 9, 4, 6, 8]) == int(inn[9])
    return (ctrl(inn, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) == int(inn[10])
            and ctrl(inn, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) == int(inn[11]))