"""
Check the robot's installed Python distributions against the declared floors.

The floors are the requirement strings in the [dependency-groups] table of
pyproject.toml, which CMakeLists.txt installs into the package share directory.
Versions are read from installed metadata, which for an editable install
records the version at the time of installation rather than the current state
of the source tree.
"""

import argparse
import sys
import tomllib
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from packaging.requirements import Requirement

DEFAULT_GROUP = "robot"
INSTALL_HINT = "pip install --break-system-packages --group pyproject.toml:robot"
PACKAGE_NAME = "stretch4_web_teleop"


def find_pyproject() -> Path:
    """
    Locate the pyproject.toml holding the dependency groups.

    Prefers the copy in the package share directory and falls back to the
    source tree above this file, so the check runs both from an installed
    workspace and from a checkout with no ROS environment sourced.

    Returns:
        Path to an existing pyproject.toml.

    Raises:
        FileNotFoundError: If neither location holds the file.
    """
    try:
        from ament_index_python.packages import get_package_share_directory

        share = Path(get_package_share_directory(PACKAGE_NAME)) / "pyproject.toml"
        if share.is_file():
            return share
    except (ImportError, LookupError):
        pass

    source = Path(__file__).resolve().parents[1] / "pyproject.toml"
    if source.is_file():
        return source

    raise FileNotFoundError(
        "pyproject.toml not found in the share directory or source tree"
    )


def check_group(group: str = DEFAULT_GROUP) -> list[str]:
    """
    Compare installed distribution versions against one dependency group.

    Nothing is installed, downloaded or modified; only metadata already present
    in the environment is read.

    Args:
        group: Name of the dependency-groups entry to check.

    Returns:
        One message per unsatisfied requirement, empty when all are satisfied.

    Raises:
        FileNotFoundError: If pyproject.toml cannot be located.
        KeyError: If the named group is absent from pyproject.toml.
    """
    with find_pyproject().open("rb") as handle:
        entries = tomllib.load(handle)["dependency-groups"][group]

    problems: list[str] = []
    for entry in entries:
        requirement = Requirement(entry)
        try:
            installed = version(requirement.name)
        except PackageNotFoundError:
            problems.append(
                f"{requirement.name} is not installed, need {requirement.specifier}"
            )
            continue
        if not requirement.specifier.contains(installed, prereleases=True):
            problems.append(
                f"{requirement.name} {installed} does not satisfy {requirement.specifier}"
            )
    return problems


def main() -> int:
    """
    Report unsatisfied requirements on stderr and return a shell exit status.

    Returns:
        0 when every requirement in the chosen group is satisfied, 1 otherwise.
    """
    parser = argparse.ArgumentParser(
        description="Check declared Python dependency floors."
    )
    parser.add_argument(
        "--group",
        default=DEFAULT_GROUP,
        help=f"dependency group to check (default: {DEFAULT_GROUP})",
    )
    arguments = parser.parse_args()

    try:
        problems = check_group(arguments.group)
    except (FileNotFoundError, KeyError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1

    for problem in problems:
        print(f"ERROR: {problem}", file=sys.stderr)
    if problems:
        print(f"       {INSTALL_HINT}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
